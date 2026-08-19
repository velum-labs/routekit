import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import {
  parseRouterConfig,
  type RouterConfig,
  splitNamespacedModel
} from "@velum-labs/routekit-config";
import { catalogDefaultModel } from "@velum-labs/routekit-registry";
import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { acquireLifecycleLock } from "@velum-labs/routekit-runtime/service";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { withCliClient } from "../../cli-client.js";
import { cliFailure, cliTry, cliTryPromise } from "../../cli-session.js";
import {
  connectDaemon,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord,
  routekitClient
} from "../../client.js";
import { DEFAULT_ROUTER_CONFIG, globalRouterConfigPath, writeRouterConfig } from "../../config.js";
import { missingServiceCredentialVariables } from "../../daemon.js";
import {
  configImportIdempotencyKey,
  ImportRouterConfig
} from "../../services/config-import/service.js";
import { routekitRoot } from "../root-command.js";

export const CONFIG_INIT_PROVIDER_IDS = ["openai", "anthropic", "openrouter", "bedrock"] as const;
export type ConfigInitProviderId = (typeof CONFIG_INIT_PROVIDER_IDS)[number];
export type ConfigInitOptions = {
  provider?: ConfigInitProviderId;
  defaultModel?: string;
  empty?: boolean;
};

const optionalString = (name: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

export function configInitRouterConfig(input: ConfigInitOptions = {}): RouterConfig {
  if (input.empty === true) return parseRouterConfig({ providers: {} });
  if (input.provider === undefined) {
    if (input.defaultModel !== undefined) throw new Error("--default-model requires --provider");
    return DEFAULT_ROUTER_CONFIG;
  }
  const registeredDefault = catalogDefaultModel(input.provider);
  const defaultModel =
    input.defaultModel ??
    (registeredDefault !== undefined ? `${input.provider}/${registeredDefault}` : undefined);
  if (input.provider === "bedrock" && defaultModel === undefined) {
    throw new Error(
      "`config init --provider bedrock` requires " +
        "`--default-model bedrock/<approved-model-or-inference-profile>`"
    );
  }
  if (defaultModel !== undefined) {
    const selected = splitNamespacedModel(defaultModel);
    if (selected.provider !== input.provider) {
      throw new Error(
        `default model "${defaultModel}" does not belong to provider "${input.provider}"`
      );
    }
  }
  return parseRouterConfig({
    providers: { [input.provider]: {} },
    ...(defaultModel !== undefined ? { defaultModel } : {})
  });
}

export function configInitIdempotencyKey(input: {
  revision: number;
  config: RouterConfig;
}): string {
  const fingerprint = createHash("sha256")
    .update(String(input.revision))
    .update("\0")
    .update(stringifyYaml(input.config))
    .digest("hex")
    .slice(0, 24);
  return `config-init-${input.revision}-${fingerprint}`;
}

export { configImportIdempotencyKey };

const makePathCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("path", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const path = (yield* withCliClient((client) => client.call("config.get", {}))).path;
      if (ctx.json) ctx.emit({ path, exists: existsSync(path) });
      else runtime.stdout.write(`${path}\n`);
    })
  ).pipe(Command.withDescription("print the canonical singleton router config path"));

const makeShowCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("show", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const result = yield* withCliClient((client) => client.call("config.get", {}));
      if (ctx.json) {
        ctx.emit({
          path: result.path,
          revision: result.revision,
          config: parseYaml(result.document)
        });
      } else runtime.stdout.write(result.document);
    })
  ).pipe(Command.withDescription("show the validated canonical singleton router config"));

const makeInitCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make(
    "init",
    {
      global: Flag.boolean("global").pipe(Flag.withHidden),
      provider: Flag.choice("provider", CONFIG_INIT_PROVIDER_IDS).pipe(
        Flag.optional,
        Flag.map(Option.getOrUndefined),
        Flag.withDescription(`API provider starter (${CONFIG_INIT_PROVIDER_IDS.join(", ")})`)
      ),
      defaultModel: optionalString("default-model").pipe(
        Flag.withDescription("set the starter's namespaced default model")
      ),
      empty: Flag.boolean("empty").pipe(
        Flag.withDescription("create an empty config before enrolling subscription accounts")
      ),
      force: Flag.boolean("force").pipe(Flag.withDescription("replace an existing config"))
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (options.empty && (options.provider !== undefined || options.defaultModel !== undefined)) {
          return yield* cliFailure("--empty conflicts with --provider and --default-model");
        }
        const path = globalRouterConfigPath();
        const starterConfig = configInitRouterConfig(options);
        const missingCredentials = missingServiceCredentialVariables(starterConfig);
        const providers = Object.keys(starterConfig.providers);
        const nextSteps =
          missingCredentials.length > 0
            ? [`set ${missingCredentials.join(" or ")}`, "run `routekit start`"]
            : providers.length === 0
              ? [
                  "run `routekit accounts login codex --name <label>` or " +
                    "`routekit accounts login claude-code --name <label>`"
                ]
              : ["run `routekit providers status`", "run `routekit models list`"];
        if (existsSync(path) && !options.force) {
          return yield* cliFailure(`${path} already exists (pass --force to replace it)`);
        }
        if (readDaemonRecord() === undefined) {
          const lock = yield* cliTryPromise(() =>
            acquireLifecycleLock(daemonLifecycleLockPath(), { timeoutMs: 90_000 })
          );
          const bootstrapped = yield* Effect.gen(function* () {
            if (readDaemonRecord() !== undefined) return false;
            if (existsSync(path) && !options.force) {
              return yield* new RouteKitFailure({
                message: `${path} already exists (pass --force to replace it)`
              });
            }
            writeRouterConfig(path, starterConfig);
            if (missingCredentials.length === 0) {
              yield* ensureDaemon({ configPath: path, lifecycleLockHeld: true });
            }
            return true;
          }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
          if (bootstrapped) {
            if (ctx.json) {
              ctx.emit({
                path,
                created: true,
                providers,
                ...(starterConfig.defaultModel !== undefined
                  ? { defaultModel: starterConfig.defaultModel }
                  : {}),
                daemonStarted: missingCredentials.length === 0,
                nextSteps,
                ...(missingCredentials.length > 0 ? { missingCredentials } : {})
              });
            } else {
              ctx.presenter.success(`created ${path}`);
              if (providers.length === 0) ctx.presenter.note("created an empty subscription bootstrap");
              else {
                ctx.presenter.note(`providers: ${providers.join(", ")}`);
                if (starterConfig.defaultModel !== undefined) {
                  ctx.presenter.note(`default model: ${starterConfig.defaultModel}`);
                }
              }
              if (missingCredentials.length > 0) {
                ctx.presenter.warn(`daemon not started: set ${missingCredentials.join(" or ")}`);
                ctx.presenter.note("then run `routekit start`");
              }
            }
            return;
          }
        }
        if (existsSync(path) && !options.force) {
          return yield* cliFailure(`${path} already exists (pass --force to replace it)`);
        }
        const connected = yield* connectDaemon;
        const client = connected?.client ?? (yield* routekitClient);
        const current = yield* client.call("config.get", {});
        if (resolve(current.path) !== resolve(path)) {
          return yield* new RouteKitFailure({
            message:
              `RouteKit is running with foreground config ${current.path}; ` +
              "stop it before replacing the canonical singleton config"
          });
        }
        yield* client.call(
          "config.update",
          { expectedRevision: current.revision, document: stringifyYaml(starterConfig) },
          {
            idempotencyKey: configInitIdempotencyKey({
              revision: current.revision,
              config: starterConfig
            })
          }
        );
        if (ctx.json) {
          ctx.emit({
            path,
            created: true,
            providers,
            ...(starterConfig.defaultModel !== undefined
              ? { defaultModel: starterConfig.defaultModel }
              : {}),
            daemonStarted: true,
            nextSteps
          });
        } else ctx.presenter.success(`created ${path}`);
      })
  ).pipe(Command.withDescription("create the canonical singleton router config"));

const makeEditCommand = (runtime: CliRuntime): Command.Command.Any =>
  Command.make("edit", { global: Flag.boolean("global").pipe(Flag.withHidden) }, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      if (ctx.json) {
        return yield* cliFailure("`config edit` is interactive and does not support --json");
      }
      const path = yield* withCliClient((client) =>
        Effect.gen(function* () {
          const snapshot = yield* client.call("config.get", {});
          const directory = mkdtempSync(join(tmpdir(), "routekit-config-"));
          const temporary = join(directory, "router.yaml");
          return yield* Effect.gen(function* () {
            writeFileSync(temporary, snapshot.document, { mode: 0o600 });
            const editor = runtime.env.EDITOR ?? runtime.env.VISUAL;
            if (editor === undefined || editor.length === 0) {
              return yield* new RouteKitFailure({
                message: "set EDITOR or VISUAL before running config edit"
              });
            }
            const result = yield* cliTry(() => spawnSync(editor, [temporary], { stdio: "inherit" }));
            if (result.error !== undefined) return yield* toRouteKitFailure(result.error);
            if (result.status !== 0) {
              return yield* new RouteKitFailure({ message: `${editor} exited with status ${result.status}` });
            }
            const editedDocument = readFileSync(temporary, "utf8");
            yield* cliTry(() => parseYaml(editedDocument));
            yield* client.call(
              "config.update",
              { expectedRevision: snapshot.revision, document: editedDocument },
              { idempotencyKey: `config-edit-${snapshot.revision}` }
            );
            return snapshot.path;
          }).pipe(
            Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
          );
        })
      );
      ctx.presenter.success(`updated ${path}`);
    })
  ).pipe(Command.withDescription("edit and atomically validate the canonical singleton router config"));

const makeImportCommand = (runtime: CliRuntime): Command.Command.Any => {
  const importRouterConfig = new ImportRouterConfig();
  return Command.make(
    "import",
    {
      from: Flag.string("from").pipe(
        Flag.withDescription("router YAML to import as the complete canonical config")
      )
    },
    ({ from }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const result = yield* importRouterConfig.execute(from);
        if (ctx.json) ctx.emit(result);
        else ctx.presenter.success(`imported ${result.source} into ${result.path}`);
      })
  ).pipe(Command.withDescription("validate a router file and replace the canonical singleton config"));
};

export const makeConfigCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make("config").pipe(
    Command.withDescription("manage router configuration"),
    Command.withSubcommands([
      makePathCommand(runtime),
      makeShowCommand(runtime),
      makeInitCommand(runtime),
      makeEditCommand(runtime),
      makeImportCommand(runtime)
    ])
  );
