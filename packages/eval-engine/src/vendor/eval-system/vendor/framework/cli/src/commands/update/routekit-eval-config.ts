import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Struct,
} from "effect";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { decodeJsonString } from "../../../../contracts/internal/src/json.ts";
import {
  decodeOrUndefined,
  optionalLenientField,
} from "./routekit-eval-config-schema.ts";
import { UpdateChannelSchema } from "./release-channel.ts";
import {
  globalRouteKitEvalConfigPath,
  localRouteKitEvalConfigPath,
} from "../../config/config-file.ts";

/**
 * `routekit-eval`'s optional configuration file. It lives at two scopes — a global
 * `~/.routekit-eval/config.json` and a workspace-local `<workspace>/.routekit-eval/config.json` —
 * and is the home for non-secret preferences such as the auto-update policy.
 *
 * Resolution precedence for a given setting (highest wins):
 *   CLI flag > environment variable > local config.json > global config.json > built-in default.
 *
 * The shared file mechanics (path helpers, resilient read, the block merge and
 * merge-preserving write) live in the neutral `config/config-file` module; this
 * module owns only the `autoUpdate` block and the top-level channel preferences.
 * The `tui` block is owned by the chat-tui feature (RFC 0006 builtin-chat-tui.md).
 */

const AUTO_UPDATE_LEVELS = ["off", "patch", "minor", "major"] as const;
type AutoUpdateLevel = (typeof AUTO_UPDATE_LEVELS)[number];

const UPDATE_RESTART_MODES = ["reexec", "exit"] as const;
type UpdateRestartMode = (typeof UPDATE_RESTART_MODES)[number];

/** Default cadence between release-channel checks: every 6 hours. */
const DEFAULT_UPDATE_INTERVAL_MS = 21_600_000;
/** Never poll faster than every 15 minutes, even if a smaller value is configured. */
const MIN_UPDATE_INTERVAL_MS = 900_000;
/**
 * Default time to wait for in-flight agent runs to finish before restarting.
 * Agent runs can take minutes, so this is generous; `0` means wait unbounded.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 600_000;
const DEFAULT_RESTART_MODE: UpdateRestartMode = "reexec";
const DEFAULT_CHANNEL = "stable" as const;

const ROUTEKIT_EVAL_AUTO_UPDATE_ENV = "ROUTEKIT_EVAL_AUTO_UPDATE";
const ROUTEKIT_EVAL_UPDATE_INTERVAL_ENV = "ROUTEKIT_EVAL_UPDATE_INTERVAL";
const ROUTEKIT_EVAL_DRAIN_TIMEOUT_ENV = "ROUTEKIT_EVAL_DRAIN_TIMEOUT";
const ROUTEKIT_EVAL_UPDATE_RESTART_ENV = "ROUTEKIT_EVAL_UPDATE_RESTART";
/** Reserved opt-out emitted by the installer; when truthy it forces auto-update off. */
const ROUTEKIT_EVAL_NO_UPDATE_CHECK_ENV = "ROUTEKIT_EVAL_NO_UPDATE_CHECK";

/**
 * The fully-resolved auto-update policy: one base struct with every field
 * required. The file-config and flag-override shapes are DERIVED from this base
 * (below) so the three never drift. `channel` is intentionally part of the
 * resolved policy but NOT the file schema: the alpha channel is a deliberate,
 * manual, per-invocation opt-in (RFC 0004 auto-update.md), never a persisted
 * subscription. It is set only via `routekit-eval start --alpha` and resolved through
 * `AutoUpdateFlagOverrides`, so the file/env precedence chain never sees it.
 */
const AutoUpdatePolicySchema = Schema.Struct({
  channel: UpdateChannelSchema,
  drainTimeoutMs: Schema.Number,
  intervalMs: Schema.Number,
  level: Schema.Literals(AUTO_UPDATE_LEVELS),
  restart: Schema.Literals(UPDATE_RESTART_MODES),
}).annotate({ identifier: "AutoUpdatePolicy" });

type ResolvedAutoUpdateConfig = typeof AutoUpdatePolicySchema.Type;

/**
 * The `autoUpdate` block of `config.json`: the policy minus the flag-only
 * `channel`, with every remaining field an absent-or-present key (never an
 * explicit `undefined` — nothing writes a literal `null`/`undefined` to the
 * file, so `optionalKey` is the exact wire contract).
 */
const AutoUpdateConfigSchema = AutoUpdatePolicySchema.mapFields(
  Struct.omit(["channel"])
).mapFields(Struct.map(optionalLenientField));

/**
 * The `routekit-eval code` early-access opt-in lives at the top level of `config.json` as
 * `earlyAccess`. Its read/write pair lives in `routekit-eval-early-access.ts`; the field
 * is modelled here too so {@link loadRouteKitEvalConfigFiles} surfaces it alongside the
 * `autoUpdate` block.
 */
const RouteKitEvalConfigFileSchema = Schema.Struct({
  autoUpdate: Schema.optionalKey(decodeOrUndefined(AutoUpdateConfigSchema)),
  channel: Schema.optionalKey(decodeOrUndefined(UpdateChannelSchema)),
  earlyAccess: Schema.optionalKey(decodeOrUndefined(Schema.Boolean)),
});

/**
 * CLI flag overrides for the auto-update policy; each wins over env and file.
 * Every policy field (including the flag-only `channel`) is optional here.
 */
const AutoUpdateFlagOverridesSchema = AutoUpdatePolicySchema.mapFields(
  Struct.map(Schema.optionalKey)
);

const decodeRouteKitEvalConfigFile = decodeJsonString(RouteKitEvalConfigFileSchema);

type AutoUpdateFileConfig = typeof AutoUpdateConfigSchema.Type;
type RouteKitEvalConfigFile = typeof RouteKitEvalConfigFileSchema.Type;
type AutoUpdateFlagOverrides = typeof AutoUpdateFlagOverridesSchema.Type;

/**
 * Read and decode a single `config.json`. Never fails: a missing, unreadable,
 * or malformed file resolves to `None` so a bad config can never stop a server
 * from booting. (Malformed files are surfaced through the auto-update log at the
 * call site, not by failing the read.)
 */
const readRouteKitEvalConfigFile = Effect.fn("RouteKitEvalConfig.readFile")(function* (
  filePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Option.none<RouteKitEvalConfigFile>();
  }
  const decoded = yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeRouteKitEvalConfigFile), Effect.option);
  return decoded;
});

/**
 * Load the global then local `config.json` as separate decoded blocks. Local
 * settings win over global, but the per-field merge is deferred to the resolver's
 * `ConfigProvider.orElse` stack rather than a hand-written deep merge. A
 * workspace root of `undefined` skips the local file (e.g. when no workspace can
 * be resolved).
 */
const loadRouteKitEvalConfigFiles = Effect.fn("RouteKitEvalConfig.load")(function* (input: {
  readonly homeDir: string;
  readonly workspaceRoot: string | undefined;
}) {
  const path = yield* Path.Path;
  const globalConfig = yield* readRouteKitEvalConfigFile(
    globalRouteKitEvalConfigPath(path, input.homeDir)
  );
  const localConfig =
    input.workspaceRoot === undefined
      ? Option.none<RouteKitEvalConfigFile>()
      : yield* readRouteKitEvalConfigFile(localRouteKitEvalConfigPath(path, input.workspaceRoot));
  return {
    global: Option.getOrElse(globalConfig, () => ({}) as RouteKitEvalConfigFile),
    local: Option.getOrElse(localConfig, () => ({}) as RouteKitEvalConfigFile),
  };
});

const parseLevel = (value: string | undefined): AutoUpdateLevel | undefined =>
  AUTO_UPDATE_LEVELS.find((level) => level === value);

const parseRestart = (
  value: string | undefined
): UpdateRestartMode | undefined =>
  UPDATE_RESTART_MODES.find((mode) => mode === value);

const parseIntegerEnv = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isTruthyEnv = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
};

const clampInterval = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_UPDATE_INTERVAL_MS;
  }
  return Math.max(value, MIN_UPDATE_INTERVAL_MS);
};

const clampDrainTimeout = (value: number | undefined): number => {
  // 0 is a legal "wait unbounded" sentinel; only negatives/NaN fall back.
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_DRAIN_TIMEOUT_MS;
  }
  return value;
};

/**
 * Project a partial policy (file block or flag overrides) into a
 * `ConfigProvider` source. Only present keys become lookup nodes, so an absent
 * field cleanly falls through to the next provider in the `orElse` stack.
 */
type AutoUpdateProviderSource = Partial<{
  [K in keyof ResolvedAutoUpdateConfig]:
    | ResolvedAutoUpdateConfig[K]
    | undefined;
}>;

const providerFromPartial = (
  source: AutoUpdateProviderSource
): ConfigProvider.ConfigProvider => ConfigProvider.fromUnknown({ ...source });

/**
 * Sanitize the raw environment into a provider. Values are parsed through the
 * lenient env parsers first; a malformed `ROUTEKIT_EVAL_AUTO_UPDATE=bogus` or a blank
 * interval parses to `undefined`, which `fromUnknown` treats as a missing key,
 * so it falls through to the file/default exactly as the previous hand-rolled
 * resolution did. (Feeding the raw string to `Config.literals`/`Config.int`
 * instead would reject and crash, since `ConfigProvider.orElse` does not catch
 * validation errors.)
 */
const providerFromEnv = (
  env: Readonly<Record<string, string | undefined>>
): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromUnknown({
    drainTimeoutMs: parseIntegerEnv(env[ROUTEKIT_EVAL_DRAIN_TIMEOUT_ENV]),
    intervalMs: parseIntegerEnv(env[ROUTEKIT_EVAL_UPDATE_INTERVAL_ENV]),
    level: parseLevel(env[ROUTEKIT_EVAL_AUTO_UPDATE_ENV]),
    restart: parseRestart(env[ROUTEKIT_EVAL_UPDATE_RESTART_ENV]),
  });

/**
 * The reserved `ROUTEKIT_EVAL_NO_UPDATE_CHECK` opt-out forces the level to `off`. It sits
 * ABOVE the env/file providers but BELOW the flag provider in the stack, so an
 * explicit `--auto-update` flag still wins over it while it overrides env and
 * file. When the opt-out is not truthy the provider is transparent (every lookup
 * returns "not found") and the stack falls through unchanged.
 */
const providerFromNoUpdateOptOut = (
  env: Readonly<Record<string, string | undefined>>
): ConfigProvider.ConfigProvider => {
  const forced = isTruthyEnv(env[ROUTEKIT_EVAL_NO_UPDATE_CHECK_ENV]);
  return ConfigProvider.make((path) =>
    Effect.succeed(
      forced && path.length === 1 && path[0] === "level"
        ? ConfigProvider.makeValue("off")
        : undefined
    )
  );
};

/**
 * Resolve the effective auto-update configuration from the precedence chain:
 * CLI flag > env var > local file > global file > built-in default. Pure: the
 * environment and (unmerged) file blocks are passed in, projected into a
 * `ConfigProvider.orElse` stack, and decoded with per-field defaults and clamps.
 *
 * The reserved `ROUTEKIT_EVAL_NO_UPDATE_CHECK` env opt-out forces the level to `off`
 * unless an explicit `--auto-update` flag is supplied.
 */
const resolveAutoUpdateConfig = Effect.fn("RouteKitEvalConfig.resolve")(
  function* (input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly globalFile: AutoUpdateFileConfig;
    readonly localFile: AutoUpdateFileConfig;
    readonly flags?: AutoUpdateFlagOverrides | undefined;
  }) {
    // Precedence, highest first: CLI flag > ROUTEKIT_EVAL_NO_UPDATE_CHECK force-off > env
    // var > local file > global file. `orElse` falls through per key when a
    // provider has no value for that path, so each layer overrides only the
    // fields it actually carries.
    const provider = providerFromPartial(input.flags ?? {}).pipe(
      ConfigProvider.orElse(providerFromNoUpdateOptOut(input.env)),
      ConfigProvider.orElse(providerFromEnv(input.env)),
      ConfigProvider.orElse(providerFromPartial(input.localFile)),
      ConfigProvider.orElse(providerFromPartial(input.globalFile))
    );

    // `channel` is supplied only by the flag provider (see the schema note): env
    // and file never carry it, so the default `stable` is the flag-only contract.
    return yield* Config.all({
      channel: Config.literals(["stable", "alpha"], "channel").pipe(
        Config.withDefault(DEFAULT_CHANNEL)
      ),
      drainTimeoutMs: Config.option(Config.number("drainTimeoutMs")).pipe(
        Config.map((value) => clampDrainTimeout(Option.getOrUndefined(value)))
      ),
      intervalMs: Config.option(Config.number("intervalMs")).pipe(
        Config.map((value) => clampInterval(Option.getOrUndefined(value)))
      ),
      level: Config.literals(AUTO_UPDATE_LEVELS, "level").pipe(
        Config.withDefault("off" as const)
      ),
      restart: Config.literals(UPDATE_RESTART_MODES, "restart").pipe(
        Config.withDefault(DEFAULT_RESTART_MODE)
      ),
    }).parse(provider);
  }
);

/**
 * Convenience: load the global and local file configs, read the environment,
 * apply flag overrides, and return the resolved auto-update configuration in one
 * step.
 */
export const resolveAutoUpdateRuntimeConfig = Effect.fn(
  "RouteKitEvalConfig.resolveAutoUpdate"
)(function* (input: {
  readonly flags?: AutoUpdateFlagOverrides;
  readonly workspaceRoot: string | undefined;
}) {
  const hostProcess = yield* HostProcess;
  const homeDir = yield* hostProcess.homeDirectory;
  const env = yield* hostProcess.env;
  const files = yield* loadRouteKitEvalConfigFiles({
    homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  return yield* resolveAutoUpdateConfig({
    env,
    flags: input.flags,
    globalFile: files.global.autoUpdate ?? {},
    localFile: files.local.autoUpdate ?? {},
  });
});

export {
  AUTO_UPDATE_LEVELS,
  UPDATE_RESTART_MODES,
  DEFAULT_UPDATE_INTERVAL_MS,
  MIN_UPDATE_INTERVAL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_RESTART_MODE,
  ROUTEKIT_EVAL_AUTO_UPDATE_ENV,
  ROUTEKIT_EVAL_UPDATE_INTERVAL_ENV,
  ROUTEKIT_EVAL_DRAIN_TIMEOUT_ENV,
  ROUTEKIT_EVAL_UPDATE_RESTART_ENV,
  ROUTEKIT_EVAL_NO_UPDATE_CHECK_ENV,
  // Re-exported from the neutral config-file module so existing importers keep
  // resolving these path helpers from here during the config split.
  globalRouteKitEvalConfigPath,
  localRouteKitEvalConfigPath,
  RouteKitEvalConfigFileSchema,
  readRouteKitEvalConfigFile,
  loadRouteKitEvalConfigFiles,
  resolveAutoUpdateConfig,
};
export type {
  AutoUpdateLevel,
  UpdateRestartMode,
  AutoUpdateFileConfig,
  RouteKitEvalConfigFile,
  ResolvedAutoUpdateConfig,
  AutoUpdateFlagOverrides,
};
