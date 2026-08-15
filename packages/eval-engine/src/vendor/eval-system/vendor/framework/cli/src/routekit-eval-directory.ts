import { Context, Effect, Layer, Option, Path, Schema } from "effect";

import type { PackedInternLauncherEnv } from "../../contracts/internal/src/cli/intern-launcher-env.ts";

import { HostProcess } from "../../contracts/internal/src/cli/host-process.ts";
import { readPackedInternLauncherEnv } from "../../contracts/internal/src/cli/intern-launcher-env.ts";

const ROUTEKIT_EVAL_DIRECTORY_NAME = ".routekit-eval";
const ROUTEKIT_EVAL_AUTH_FILE_NAME = "credentials.json";
/**
 * Dedicated workspace-local run credential for `routekit-eval start`. When present it is
 * preferred over {@link ROUTEKIT_EVAL_AUTH_FILE_NAME}, letting a deployment supply a
 * separate run key from the interactive dev key (RFC 0004 start.md). A
 * workspace that does nothing special keeps using its single `credentials.json`.
 */
const ROUTEKIT_EVAL_START_CREDENTIAL_FILE_NAME = "start.json";
const GATEWAY_DIRECTORY_NAME = ".gateway";
const ROUTEKIT_EVAL_AUTHOR_CONTRACTS_DIRECTORY = "sdk";
const ROUTEKIT_EVAL_DOCS_DIRECTORY = "docs";
/**
 * Subdirectory of `.routekit-eval/` holding what `routekit-eval eval` keeps between runs. Sits beside
 * the event logs rather than in `~/.routekit-eval` because a pass rate belongs to one
 * project's evals; a shared global series would interleave unrelated projects.
 */
const ROUTEKIT_EVAL_DIRECTORY = "eval";
/**
 * Append-only summary of past `routekit-eval eval` runs, one JSON line each. Bounded by the
 * writer (`commands/eval/history.ts`), and git-ignored along with the rest of
 * `.routekit-eval/`, so it never turns up in a diff.
 */
const ROUTEKIT_EVAL_HISTORY_FILE = "history.jsonl";
/**
 * File name of the framework-owned oxlint config that `routekit-eval ci lint` materializes
 * into the git-ignored `.routekit-eval/` cache at run time. The ruleset ships compiled
 * into the CLI binary; a generated workspace carries no lint config of its own,
 * so this file is always reconstructed from the binary rather than authored.
 */
const ROUTEKIT_EVAL_LINT_CONFIG_FILE = "oxlintrc.json";
/**
 * File name of the framework-owned oxfmt config that `routekit-eval ci lint` materializes into
 * the toolchain cache. Generated from the repo's own `oxfmt.config.ts`; `routekit-eval ci lint`
 * runs oxfmt after `oxlint --fix` so the stylistic autofix converges (see the fix
 * pipeline note in the repo `oxlint.config.ts`).
 */
const ROUTEKIT_EVAL_OXFMT_CONFIG_FILE = "oxfmtrc.json";
/**
 * File name of the framework-owned markdownlint config that `routekit-eval ci lint`
 * materializes into the toolchain cache. Like the oxlint config it is generated
 * from the repo's own `.markdownlint.json` and reconstructed from the binary
 * rather than authored in the workspace.
 */
const ROUTEKIT_EVAL_MARKDOWNLINT_CONFIG_FILE = ".markdownlint.json";
/**
 * File name of the framework-owned syncpack config that `routekit-eval ci lint` materializes
 * into the toolchain cache. Its policy is generated from the repo's own
 * `.syncpackrc.json`; the intern `source` globs are injected before writing.
 */
const ROUTEKIT_EVAL_SYNCPACK_CONFIG_FILE = ".syncpackrc.json";
/**
 * File name of the framework-owned knip config that `routekit-eval ci lint` materializes into
 * the toolchain cache. Shaped for the intern's `features/*` layout.
 */
const ROUTEKIT_EVAL_KNIP_CONFIG_FILE = "knip.json";
/**
 * Subdirectory of `.routekit-eval/` that holds the linter toolchain `routekit-eval ci lint` provisions
 * on first run: a generated `package.json` plus its installed `node_modules`
 * (oxlint, the type-aware `tsgolint` engine, and the `@stylistic` JS plugin). The
 * scaffold itself ships no lint dependency; oxlint resolves plugins and the
 * tsgolint binary from the cwd it runs in, so the linter is invoked with its cwd
 * set here while the workspace is linted by absolute path.
 */
const ROUTEKIT_EVAL_LINT_CACHE_DIR = "lint";
const ROUTEKIT_EVAL_GITIGNORE_ENTRY = `${ROUTEKIT_EVAL_DIRECTORY_NAME}/`;
/**
 * Subdirectory of `~/.routekit-eval` that holds the global RouteKitEval workspace. Keeping the
 * workspace under its own directory (rather than `~/.routekit-eval` itself) leaves the
 * global credential file at `~/.routekit-eval/credentials.json` clean and puts the
 * workspace's own runtime state under `~/.routekit-eval/global/.routekit-eval`.
 */
const ROUTEKIT_EVAL_GLOBAL_WORKSPACE_DIR = "global";
/**
 * Subdirectory of `~/.routekit-eval` that holds machine-wide caches of downloaded release
 * artifacts. The docs bundle lives at `cache/docs/<version>/docs-bundle.json`:
 * it ships as a release asset rather than compiled into the binary, so it is
 * fetched once per CLI version and then read from here (including offline).
 */
const ROUTEKIT_EVAL_CACHE_DIR = "cache";
const ROUTEKIT_EVAL_DOCS_BUNDLE_FILE = "docs-bundle.json";
const FEATURES_DIRECTORY_NAME = "features";

type AuthStorageScope = "global" | "workspace" | "workspace-preferred";

interface AuthPathInput {
  readonly homeDir: string;
  readonly scope: AuthStorageScope;
  readonly startDir: string;
}

interface RouteKitEvalDirectoryShape {
  readonly authPath: (
    input: AuthPathInput
  ) => Effect.Effect<string, WorkspaceRootNotFound>;
  readonly authorContractsCacheDir: (projectRoot: string) => string;
  readonly docsCacheDir: (projectRoot: string) => string;
  /**
   * Where `routekit-eval eval` keeps its per-run summaries, `.routekit/eval/history.jsonl`.
   * Workspace-local so a pass rate stays a fact about one project's evals.
   */
  readonly evalHistoryPath: (workspaceRoot: string) => string;
  /** Downloaded docs bundle for one CLI version, `~/.routekit-eval/cache/docs/<version>/docs-bundle.json`. */
  readonly docsBundleCachePath: (homeDir: string, version: string) => string;
  /** Root of the git-ignored linter toolchain cache, `.routekit-eval/lint`. */
  readonly lintCacheDir: (workspaceRoot: string) => string;
  /**
   * Absolute path of the materialized internal oxlint config,
   * `.routekit-eval/lint/oxlintrc.json`. It lives inside the toolchain cache so oxlint
   * resolves its JS plugins from the cache's `node_modules`.
   */
  readonly lintConfigPath: (workspaceRoot: string) => string;
  /**
   * Absolute path of the materialized internal oxfmt config,
   * `.routekit-eval/lint/oxfmtrc.json`. It lives inside the toolchain cache alongside the
   * oxlint config so `routekit-eval ci lint` can point oxfmt at it after `oxlint --fix`.
   */
  readonly oxfmtConfigPath: (workspaceRoot: string) => string;
  /**
   * Absolute path of the materialized internal markdownlint config,
   * `.routekit-eval/lint/.markdownlint.json`.
   */
  readonly markdownlintConfigPath: (workspaceRoot: string) => string;
  /** Absolute path of the materialized syncpack config, `.routekit-eval/lint/.syncpackrc.json`. */
  readonly syncpackConfigPath: (workspaceRoot: string) => string;
  /** Absolute path of the materialized knip config, `.routekit-eval/lint/knip.json`. */
  readonly knipConfigPath: (workspaceRoot: string) => string;
  readonly globalAuthPath: (homeDir: string) => string;
  /**
   * Fallback path `~/.gateway/credentials.json` — checked after `~/.routekit-eval/credentials.json`
   * when no credential is found in the primary global location.
   */
  readonly globalCredentialFallbackPath: (homeDir: string) => string;
  /** Root of the global RouteKitEval workspace, `~/.routekit-eval/global`. */
  readonly globalWorkspaceRoot: (homeDir: string) => string;
  /** Features directory of the global RouteKitEval workspace, `~/.routekit-eval/global/features`. */
  readonly globalFeaturesRoot: (homeDir: string) => string;
  readonly localAuthPath: (workspaceRoot: string) => string;
  /**
   * Workspace-local run credential `.routekit-eval/start.json`, preferred by `routekit-eval start`
   * over {@link localAuthPath} when present.
   */
  readonly localRunCredentialPath: (workspaceRoot: string) => string;
  readonly workspaceRootFrom: (
    startDir: string
  ) => Effect.Effect<Option.Option<string>>;
}

class WorkspaceRootNotFound extends Schema.TaggedErrorClass<WorkspaceRootNotFound>()(
  "WorkspaceRootNotFound",
  {
    startDir: Schema.String,
  }
) {
  override get message(): string {
    return `Could not find an RouteKitEval workspace root at or above ${this.startDir}.`;
  }
}

export class RouteKitEvalDirectory extends Context.Service<
  RouteKitEvalDirectory,
  RouteKitEvalDirectoryShape
>()("routekit-eval/cli/RouteKitEvalDirectory") {
  /**
   * Test seam: an `RouteKitEvalDirectory` whose path resolvers return deterministic stub
   * paths under `/tmp` and whose workspace lookup reports "no workspace". Override
   * only the fields a case cares about; the effectful live implementation that
   * probes the real filesystem lives in the `RouteKitEvalDirectoryLive` adapter
   * (`routekit-eval-directory-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<RouteKitEvalDirectoryShape>
  ): Layer.Layer<RouteKitEvalDirectory> =>
    Layer.succeed(RouteKitEvalDirectory)(
      RouteKitEvalDirectory.of({
        authPath: () => Effect.succeed("/tmp/.routekit-eval/credentials.json"),
        authorContractsCacheDir: () => "/tmp/.routekit-eval/sdk",
        docsBundleCachePath: () => "/tmp/.routekit-eval/cache/docs/test/docs-bundle.json",
        docsCacheDir: () => "/tmp/.routekit-eval/docs",
        evalHistoryPath: () => "/tmp/.routekit/eval/history.jsonl",
        globalAuthPath: () => "/tmp/.routekit-eval/credentials.json",
        globalCredentialFallbackPath: () => "/tmp/.gateway/credentials.json",
        globalFeaturesRoot: () => "/tmp/.routekit-eval/global/features",
        globalWorkspaceRoot: () => "/tmp/.routekit-eval/global",
        knipConfigPath: () => "/tmp/.routekit-eval/lint/knip.json",
        lintCacheDir: () => "/tmp/.routekit-eval/lint",
        lintConfigPath: () => "/tmp/.routekit-eval/lint/oxlintrc.json",
        localAuthPath: () => "/tmp/.routekit-eval/credentials.json",
        localRunCredentialPath: () => "/tmp/.routekit-eval/start.json",
        markdownlintConfigPath: () => "/tmp/.routekit-eval/lint/.markdownlint.json",
        oxfmtConfigPath: () => "/tmp/.routekit-eval/lint/oxfmtrc.json",
        syncpackConfigPath: () => "/tmp/.routekit-eval/lint/.syncpackrc.json",
        workspaceRootFrom: () => Effect.succeed(Option.none<string>()),
        ...impl,
      })
    );
}

/** Resolve `~/.routekit-eval/global` from the host home directory. */
export const resolveGlobalWorkspaceRoot = Effect.fn(
  "RouteKitEvalDirectory.resolveGlobalWorkspaceRoot"
)(function* () {
  const hostProcess = yield* HostProcess;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return routeKitEvalDirectory.globalWorkspaceRoot(homeDir);
});

/** Resolve `~/.routekit-eval/global/features` from the host home directory. */
export const resolveGlobalFeaturesRoot = Effect.fn(
  "RouteKitEvalDirectory.resolveGlobalFeaturesRoot"
)(function* () {
  const hostProcess = yield* HostProcess;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return routeKitEvalDirectory.globalFeaturesRoot(homeDir);
});

/** Resolve `~/.routekit-eval/credentials.json` from the host home directory. */
export const resolveGlobalAuthPath = Effect.fn(
  "RouteKitEvalDirectory.resolveGlobalAuthPath"
)(function* () {
  const hostProcess = yield* HostProcess;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return routeKitEvalDirectory.globalAuthPath(homeDir);
});

/** Resolve the fallback `~/.gateway/credentials.json` from the host home directory. */
export const resolveGlobalCredentialFallbackPath = Effect.fn(
  "RouteKitEvalDirectory.resolveGlobalCredentialFallbackPath"
)(function* () {
  const hostProcess = yield* HostProcess;
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return routeKitEvalDirectory.globalCredentialFallbackPath(homeDir);
});

/**
 * Resolve a scoped auth path, sourcing the home directory from {@link HostProcess}
 * rather than threading it through caller signatures. The `global` and
 * `workspace-preferred` (no-workspace) scopes resolve under `~/.routekit-eval`; `workspace`
 * scopes resolve under the discovered workspace root.
 */
export const resolveAuthPath = Effect.fn("RouteKitEvalDirectory.resolveAuthPath")(
  function* (input: {
    readonly scope: AuthStorageScope;
    readonly startDir: string;
  }) {
    const hostProcess = yield* HostProcess;
    const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
    const homeDir = yield* hostProcess.homeDirectory;
    return yield* routeKitEvalDirectory.authPath({
      homeDir,
      scope: input.scope,
      startDir: input.startDir,
    });
  }
);

/**
 * Resolve the workspace-search start directory for an intern-launcher-aware
 * command (`routekit-eval tui`/`sessions`/`schedules`/`logs`): prefer the workspace root
 * pinned by the packed intern launcher, otherwise the current working directory.
 * Kept pure so the precedence is unit-testable without an Effect runtime; the
 * effectful {@link resolveLauncherStartDir} wires the env read and cwd into it.
 */
export const selectLauncherStartDir = (
  launcherEnv: PackedInternLauncherEnv,
  cwd: string
): string => launcherEnv.workspaceRoot ?? cwd;

/**
 * Resolve the start directory for launcher-aware commands by reading the packed
 * intern launcher env from {@link HostProcess} and falling back to cwd. This is
 * the launcher-aware counterpart to {@link resolveStartDir}; the two differ in
 * their preferred source (launcher workspace vs. an explicit caller override),
 * which is why they are distinct accessors rather than one.
 */
export const resolveLauncherStartDir = Effect.fn(
  "RouteKitEvalDirectory.resolveLauncherStartDir"
)(function* () {
  const hostProcess = yield* HostProcess;
  const path = yield* Path.Path;
  const launcherEnv = readPackedInternLauncherEnv(yield* hostProcess.env);
  return selectLauncherStartDir(launcherEnv, path.resolve());
});

/**
 * Resolve the workspace-search start directory for a cwd-defaulting command
 * (`routekit-eval login` and the credential gate): use the caller-supplied override when
 * present, otherwise the current working directory from {@link HostProcess}.
 * Unlike {@link resolveLauncherStartDir} this never consults the intern-launcher
 * env — login must pin to the directory the user is standing in, not an ambient
 * launcher hint.
 */
export const resolveStartDir = Effect.fn("RouteKitEvalDirectory.resolveStartDir")(
  function* (override?: string) {
    if (override !== undefined) {
      return override;
    }
    const hostProcess = yield* HostProcess;
    return yield* hostProcess.currentWorkingDirectory;
  }
);

export {
  ROUTEKIT_EVAL_DIRECTORY_NAME,
  ROUTEKIT_EVAL_AUTH_FILE_NAME,
  ROUTEKIT_EVAL_START_CREDENTIAL_FILE_NAME,
  GATEWAY_DIRECTORY_NAME,
  ROUTEKIT_EVAL_AUTHOR_CONTRACTS_DIRECTORY,
  ROUTEKIT_EVAL_DOCS_DIRECTORY,
  ROUTEKIT_EVAL_DIRECTORY,
  ROUTEKIT_EVAL_HISTORY_FILE,
  ROUTEKIT_EVAL_CACHE_DIR,
  ROUTEKIT_EVAL_DOCS_BUNDLE_FILE,
  ROUTEKIT_EVAL_LINT_CONFIG_FILE,
  ROUTEKIT_EVAL_OXFMT_CONFIG_FILE,
  ROUTEKIT_EVAL_MARKDOWNLINT_CONFIG_FILE,
  ROUTEKIT_EVAL_SYNCPACK_CONFIG_FILE,
  ROUTEKIT_EVAL_KNIP_CONFIG_FILE,
  ROUTEKIT_EVAL_LINT_CACHE_DIR,
  ROUTEKIT_EVAL_GITIGNORE_ENTRY,
  ROUTEKIT_EVAL_GLOBAL_WORKSPACE_DIR,
  FEATURES_DIRECTORY_NAME,
  WorkspaceRootNotFound,
};
export type { AuthStorageScope, AuthPathInput, RouteKitEvalDirectoryShape };
