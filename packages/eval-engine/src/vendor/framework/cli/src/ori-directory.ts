import { Context, Effect, Layer, Option, Path, Schema } from "effect";

import type { PackedInternLauncherEnv } from "../../contracts/internal/src/cli/intern-launcher-env.ts";

import { HostProcess } from "../../contracts/internal/src/cli/host-process.ts";
import { readPackedInternLauncherEnv } from "../../contracts/internal/src/cli/intern-launcher-env.ts";

const ORI_DIRECTORY_NAME = ".ori";
const ORI_AUTH_FILE_NAME = "credentials.json";
/**
 * Dedicated workspace-local run credential for `ori start`. When present it is
 * preferred over {@link ORI_AUTH_FILE_NAME}, letting a deployment supply a
 * separate run key from the interactive dev key (RFC 0004 start.md). A
 * workspace that does nothing special keeps using its single `credentials.json`.
 */
const ORI_START_CREDENTIAL_FILE_NAME = "start.json";
const OPENROUTER_DIRECTORY_NAME = ".openrouter";
const ORI_AUTHOR_CONTRACTS_DIRECTORY = "sdk";
const ORI_DOCS_DIRECTORY = "docs";
/**
 * Subdirectory of `.ori/` holding what `ori eval` keeps between runs. Sits beside
 * the event logs rather than in `~/.ori` because a pass rate belongs to one
 * project's evals; a shared global series would interleave unrelated projects.
 */
const ORI_EVAL_DIRECTORY = "eval";
/**
 * Append-only summary of past `ori eval` runs, one JSON line each. Bounded by the
 * writer (`commands/eval/history.ts`), and git-ignored along with the rest of
 * `.ori/`, so it never turns up in a diff.
 */
const ORI_EVAL_HISTORY_FILE = "history.jsonl";
/**
 * File name of the framework-owned oxlint config that `ori ci lint` materializes
 * into the git-ignored `.ori/` cache at run time. The ruleset ships compiled
 * into the CLI binary; a generated workspace carries no lint config of its own,
 * so this file is always reconstructed from the binary rather than authored.
 */
const ORI_LINT_CONFIG_FILE = "oxlintrc.json";
/**
 * File name of the framework-owned oxfmt config that `ori ci lint` materializes into
 * the toolchain cache. Generated from the repo's own `oxfmt.config.ts`; `ori ci lint`
 * runs oxfmt after `oxlint --fix` so the stylistic autofix converges (see the fix
 * pipeline note in the repo `oxlint.config.ts`).
 */
const ORI_OXFMT_CONFIG_FILE = "oxfmtrc.json";
/**
 * File name of the framework-owned markdownlint config that `ori ci lint`
 * materializes into the toolchain cache. Like the oxlint config it is generated
 * from the repo's own `.markdownlint.json` and reconstructed from the binary
 * rather than authored in the workspace.
 */
const ORI_MARKDOWNLINT_CONFIG_FILE = ".markdownlint.json";
/**
 * File name of the framework-owned syncpack config that `ori ci lint` materializes
 * into the toolchain cache. Its policy is generated from the repo's own
 * `.syncpackrc.json`; the intern `source` globs are injected before writing.
 */
const ORI_SYNCPACK_CONFIG_FILE = ".syncpackrc.json";
/**
 * File name of the framework-owned knip config that `ori ci lint` materializes into
 * the toolchain cache. Shaped for the intern's `features/*` layout.
 */
const ORI_KNIP_CONFIG_FILE = "knip.json";
/**
 * Subdirectory of `.ori/` that holds the linter toolchain `ori ci lint` provisions
 * on first run: a generated `package.json` plus its installed `node_modules`
 * (oxlint, the type-aware `tsgolint` engine, and the `@stylistic` JS plugin). The
 * scaffold itself ships no lint dependency; oxlint resolves plugins and the
 * tsgolint binary from the cwd it runs in, so the linter is invoked with its cwd
 * set here while the workspace is linted by absolute path.
 */
const ORI_LINT_CACHE_DIR = "lint";
const ORI_GITIGNORE_ENTRY = `${ORI_DIRECTORY_NAME}/`;
/**
 * Subdirectory of `~/.ori` that holds the global Ori workspace. Keeping the
 * workspace under its own directory (rather than `~/.ori` itself) leaves the
 * global credential file at `~/.ori/credentials.json` clean and puts the
 * workspace's own runtime state under `~/.ori/global/.ori`.
 */
const ORI_GLOBAL_WORKSPACE_DIR = "global";
/**
 * Subdirectory of `~/.ori` that holds machine-wide caches of downloaded release
 * artifacts. The docs bundle lives at `cache/docs/<version>/docs-bundle.json`:
 * it ships as a release asset rather than compiled into the binary, so it is
 * fetched once per CLI version and then read from here (including offline).
 */
const ORI_CACHE_DIR = "cache";
const ORI_DOCS_BUNDLE_FILE = "docs-bundle.json";
const FEATURES_DIRECTORY_NAME = "features";

type AuthStorageScope = "global" | "workspace" | "workspace-preferred";

interface AuthPathInput {
  readonly homeDir: string;
  readonly scope: AuthStorageScope;
  readonly startDir: string;
}

interface OriDirectoryShape {
  readonly authPath: (
    input: AuthPathInput
  ) => Effect.Effect<string, WorkspaceRootNotFound>;
  readonly authorContractsCacheDir: (projectRoot: string) => string;
  readonly docsCacheDir: (projectRoot: string) => string;
  /**
   * Where `ori eval` keeps its per-run summaries, `.ori/eval/history.jsonl`.
   * Workspace-local so a pass rate stays a fact about one project's evals.
   */
  readonly evalHistoryPath: (workspaceRoot: string) => string;
  /** Downloaded docs bundle for one CLI version, `~/.ori/cache/docs/<version>/docs-bundle.json`. */
  readonly docsBundleCachePath: (homeDir: string, version: string) => string;
  /** Root of the git-ignored linter toolchain cache, `.ori/lint`. */
  readonly lintCacheDir: (workspaceRoot: string) => string;
  /**
   * Absolute path of the materialized internal oxlint config,
   * `.ori/lint/oxlintrc.json`. It lives inside the toolchain cache so oxlint
   * resolves its JS plugins from the cache's `node_modules`.
   */
  readonly lintConfigPath: (workspaceRoot: string) => string;
  /**
   * Absolute path of the materialized internal oxfmt config,
   * `.ori/lint/oxfmtrc.json`. It lives inside the toolchain cache alongside the
   * oxlint config so `ori ci lint` can point oxfmt at it after `oxlint --fix`.
   */
  readonly oxfmtConfigPath: (workspaceRoot: string) => string;
  /**
   * Absolute path of the materialized internal markdownlint config,
   * `.ori/lint/.markdownlint.json`.
   */
  readonly markdownlintConfigPath: (workspaceRoot: string) => string;
  /** Absolute path of the materialized syncpack config, `.ori/lint/.syncpackrc.json`. */
  readonly syncpackConfigPath: (workspaceRoot: string) => string;
  /** Absolute path of the materialized knip config, `.ori/lint/knip.json`. */
  readonly knipConfigPath: (workspaceRoot: string) => string;
  readonly globalAuthPath: (homeDir: string) => string;
  /**
   * Fallback path `~/.openrouter/credentials.json` — checked after `~/.ori/credentials.json`
   * when no credential is found in the primary global location.
   */
  readonly globalCredentialFallbackPath: (homeDir: string) => string;
  /** Root of the global Ori workspace, `~/.ori/global`. */
  readonly globalWorkspaceRoot: (homeDir: string) => string;
  /** Features directory of the global Ori workspace, `~/.ori/global/features`. */
  readonly globalFeaturesRoot: (homeDir: string) => string;
  readonly localAuthPath: (workspaceRoot: string) => string;
  /**
   * Workspace-local run credential `.ori/start.json`, preferred by `ori start`
   * over {@link localAuthPath} when present.
   */
  readonly localRunCredentialPath: (workspaceRoot: string) => string;
  readonly workspaceRootFrom: (
    startDir: string
  ) => Effect.Effect<Option.Option<string>>;
}

class WorkspaceRootNotFound extends Schema.TaggedError<WorkspaceRootNotFound>()(
  "WorkspaceRootNotFound",
  {
    startDir: Schema.String,
  }
) {
  override get message(): string {
    return `Could not find an Ori workspace root at or above ${this.startDir}.`;
  }
}

export class OriDirectory extends Context.Service<
  OriDirectory,
  OriDirectoryShape
>()("ori/cli/OriDirectory") {
  /**
   * Test seam: an `OriDirectory` whose path resolvers return deterministic stub
   * paths under `/tmp` and whose workspace lookup reports "no workspace". Override
   * only the fields a case cares about; the effectful live implementation that
   * probes the real filesystem lives in the `OriDirectoryLive` adapter
   * (`ori-directory-live.ts`).
   */
  static readonly layerTest = (
    impl: Partial<OriDirectoryShape>
  ): Layer.Layer<OriDirectory> =>
    Layer.succeed(OriDirectory)(
      OriDirectory.of({
        authPath: () => Effect.succeed("/tmp/.ori/credentials.json"),
        authorContractsCacheDir: () => "/tmp/.ori/sdk",
        docsBundleCachePath: () => "/tmp/.ori/cache/docs/test/docs-bundle.json",
        docsCacheDir: () => "/tmp/.ori/docs",
        evalHistoryPath: () => "/tmp/.ori/eval/history.jsonl",
        globalAuthPath: () => "/tmp/.ori/credentials.json",
        globalCredentialFallbackPath: () => "/tmp/.openrouter/credentials.json",
        globalFeaturesRoot: () => "/tmp/.ori/global/features",
        globalWorkspaceRoot: () => "/tmp/.ori/global",
        knipConfigPath: () => "/tmp/.ori/lint/knip.json",
        lintCacheDir: () => "/tmp/.ori/lint",
        lintConfigPath: () => "/tmp/.ori/lint/oxlintrc.json",
        localAuthPath: () => "/tmp/.ori/credentials.json",
        localRunCredentialPath: () => "/tmp/.ori/start.json",
        markdownlintConfigPath: () => "/tmp/.ori/lint/.markdownlint.json",
        oxfmtConfigPath: () => "/tmp/.ori/lint/oxfmtrc.json",
        syncpackConfigPath: () => "/tmp/.ori/lint/.syncpackrc.json",
        workspaceRootFrom: () => Effect.succeed(Option.none<string>()),
        ...impl,
      })
    );
}

/** Resolve `~/.ori/global` from the host home directory. */
export const resolveGlobalWorkspaceRoot = Effect.fn(
  "OriDirectory.resolveGlobalWorkspaceRoot"
)(function* () {
  const hostProcess = yield* HostProcess;
  const oriDirectory = yield* OriDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return oriDirectory.globalWorkspaceRoot(homeDir);
});

/** Resolve `~/.ori/global/features` from the host home directory. */
export const resolveGlobalFeaturesRoot = Effect.fn(
  "OriDirectory.resolveGlobalFeaturesRoot"
)(function* () {
  const hostProcess = yield* HostProcess;
  const oriDirectory = yield* OriDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return oriDirectory.globalFeaturesRoot(homeDir);
});

/** Resolve `~/.ori/credentials.json` from the host home directory. */
export const resolveGlobalAuthPath = Effect.fn(
  "OriDirectory.resolveGlobalAuthPath"
)(function* () {
  const hostProcess = yield* HostProcess;
  const oriDirectory = yield* OriDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return oriDirectory.globalAuthPath(homeDir);
});

/** Resolve the fallback `~/.openrouter/credentials.json` from the host home directory. */
export const resolveGlobalCredentialFallbackPath = Effect.fn(
  "OriDirectory.resolveGlobalCredentialFallbackPath"
)(function* () {
  const hostProcess = yield* HostProcess;
  const oriDirectory = yield* OriDirectory;
  const homeDir = yield* hostProcess.homeDirectory;
  return oriDirectory.globalCredentialFallbackPath(homeDir);
});

/**
 * Resolve a scoped auth path, sourcing the home directory from {@link HostProcess}
 * rather than threading it through caller signatures. The `global` and
 * `workspace-preferred` (no-workspace) scopes resolve under `~/.ori`; `workspace`
 * scopes resolve under the discovered workspace root.
 */
export const resolveAuthPath = Effect.fn("OriDirectory.resolveAuthPath")(
  function* (input: {
    readonly scope: AuthStorageScope;
    readonly startDir: string;
  }) {
    const hostProcess = yield* HostProcess;
    const oriDirectory = yield* OriDirectory;
    const homeDir = yield* hostProcess.homeDirectory;
    return yield* oriDirectory.authPath({
      homeDir,
      scope: input.scope,
      startDir: input.startDir,
    });
  }
);

/**
 * Resolve the workspace-search start directory for an intern-launcher-aware
 * command (`ori tui`/`sessions`/`schedules`/`logs`): prefer the workspace root
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
  "OriDirectory.resolveLauncherStartDir"
)(function* () {
  const hostProcess = yield* HostProcess;
  const path = yield* Path.Path;
  const launcherEnv = readPackedInternLauncherEnv(yield* hostProcess.env);
  return selectLauncherStartDir(launcherEnv, path.resolve());
});

/**
 * Resolve the workspace-search start directory for a cwd-defaulting command
 * (`ori login` and the credential gate): use the caller-supplied override when
 * present, otherwise the current working directory from {@link HostProcess}.
 * Unlike {@link resolveLauncherStartDir} this never consults the intern-launcher
 * env — login must pin to the directory the user is standing in, not an ambient
 * launcher hint.
 */
export const resolveStartDir = Effect.fn("OriDirectory.resolveStartDir")(
  function* (override?: string) {
    if (override !== undefined) {
      return override;
    }
    const hostProcess = yield* HostProcess;
    return yield* hostProcess.currentWorkingDirectory;
  }
);

export {
  ORI_DIRECTORY_NAME,
  ORI_AUTH_FILE_NAME,
  ORI_START_CREDENTIAL_FILE_NAME,
  OPENROUTER_DIRECTORY_NAME,
  ORI_AUTHOR_CONTRACTS_DIRECTORY,
  ORI_DOCS_DIRECTORY,
  ORI_EVAL_DIRECTORY,
  ORI_EVAL_HISTORY_FILE,
  ORI_CACHE_DIR,
  ORI_DOCS_BUNDLE_FILE,
  ORI_LINT_CONFIG_FILE,
  ORI_OXFMT_CONFIG_FILE,
  ORI_MARKDOWNLINT_CONFIG_FILE,
  ORI_SYNCPACK_CONFIG_FILE,
  ORI_KNIP_CONFIG_FILE,
  ORI_LINT_CACHE_DIR,
  ORI_GITIGNORE_ENTRY,
  ORI_GLOBAL_WORKSPACE_DIR,
  FEATURES_DIRECTORY_NAME,
  WorkspaceRootNotFound,
};
export type { AuthStorageScope, AuthPathInput, OriDirectoryShape };
