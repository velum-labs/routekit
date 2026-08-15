import { Effect, FileSystem, Layer, Option, Path } from "effect";

import type {
  AuthPathInput,
  RouteKitEvalDirectoryShape,
} from "./routekit-eval-directory.ts";

import { findWorkspaceRootFromCwd } from "../../runloop/local/src/dev/descriptor.ts";
import {
  FEATURES_DIRECTORY_NAME,
  GATEWAY_DIRECTORY_NAME,
  ROUTEKIT_EVAL_AUTH_FILE_NAME,
  ROUTEKIT_EVAL_AUTHOR_CONTRACTS_DIRECTORY,
  ROUTEKIT_EVAL_CACHE_DIR,
  ROUTEKIT_EVAL_DIRECTORY_NAME,
  ROUTEKIT_EVAL_DOCS_BUNDLE_FILE,
  ROUTEKIT_EVAL_DOCS_DIRECTORY,
  ROUTEKIT_EVAL_DIRECTORY,
  ROUTEKIT_EVAL_HISTORY_FILE,
  ROUTEKIT_EVAL_GLOBAL_WORKSPACE_DIR,
  ROUTEKIT_EVAL_KNIP_CONFIG_FILE,
  ROUTEKIT_EVAL_LINT_CACHE_DIR,
  ROUTEKIT_EVAL_LINT_CONFIG_FILE,
  ROUTEKIT_EVAL_MARKDOWNLINT_CONFIG_FILE,
  ROUTEKIT_EVAL_OXFMT_CONFIG_FILE,
  ROUTEKIT_EVAL_START_CREDENTIAL_FILE_NAME,
  ROUTEKIT_EVAL_SYNCPACK_CONFIG_FILE,
  RouteKitEvalDirectory,
  WorkspaceRootNotFound,
} from "./routekit-eval-directory.ts";

const makeWorkspaceRootFrom = (
  fs: FileSystem.FileSystem,
  path: Path.Path
): RouteKitEvalDirectoryShape["workspaceRootFrom"] =>
  Effect.fn("RouteKitEvalDirectory.workspaceRootFrom")(function* (
    startDir: string
  ): Effect.fn.Return<Option.Option<string>> {
    const workspaceRoot = yield* findWorkspaceRootFromCwd(
      fs,
      path,
      startDir
    ).pipe(Effect.orElseSucceed(() => null));
    return workspaceRoot === null
      ? Option.none<string>()
      : Option.some(workspaceRoot);
  });

const makeAuthPath = (deps: {
  readonly globalAuthPath: (homeDir: string) => string;
  readonly localAuthPath: (workspaceRoot: string) => string;
  readonly workspaceRootFrom: RouteKitEvalDirectoryShape["workspaceRootFrom"];
}): RouteKitEvalDirectoryShape["authPath"] =>
  Effect.fn("RouteKitEvalDirectory.authPath")(function* (
    input: AuthPathInput
  ): Effect.fn.Return<string, WorkspaceRootNotFound> {
    if (input.scope === "global") {
      return deps.globalAuthPath(input.homeDir);
    }

    const workspaceRoot = yield* deps.workspaceRootFrom(input.startDir);
    if (Option.isSome(workspaceRoot)) {
      return deps.localAuthPath(workspaceRoot.value);
    }

    if (input.scope === "workspace-preferred") {
      return deps.globalAuthPath(input.homeDir);
    }

    return yield* new WorkspaceRootNotFound({ startDir: input.startDir });
  });

// The lint cache paths all hang off `lintCacheDir`, so they are built as one
// group rather than inline in the shape.
const makeLintPaths = (
  path: Path.Path
): Pick<
  RouteKitEvalDirectoryShape,
  | "knipConfigPath"
  | "lintCacheDir"
  | "lintConfigPath"
  | "markdownlintConfigPath"
  | "oxfmtConfigPath"
  | "syncpackConfigPath"
> => {
  const lintCacheDir = (workspaceRoot: string): string =>
    path.join(workspaceRoot, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_LINT_CACHE_DIR);
  return {
    knipConfigPath: (workspaceRoot: string): string =>
      path.join(lintCacheDir(workspaceRoot), ROUTEKIT_EVAL_KNIP_CONFIG_FILE),
    lintCacheDir,
    // The config lives INSIDE the toolchain cache: oxlint resolves `jsPlugins`
    // relative to the config file's own directory, so it must sit next to the
    // cache's `node_modules` for `@stylistic/eslint-plugin` to load.
    lintConfigPath: (workspaceRoot: string): string =>
      path.join(lintCacheDir(workspaceRoot), ROUTEKIT_EVAL_LINT_CONFIG_FILE),
    markdownlintConfigPath: (workspaceRoot: string): string =>
      path.join(lintCacheDir(workspaceRoot), ROUTEKIT_EVAL_MARKDOWNLINT_CONFIG_FILE),
    oxfmtConfigPath: (workspaceRoot: string): string =>
      path.join(lintCacheDir(workspaceRoot), ROUTEKIT_EVAL_OXFMT_CONFIG_FILE),
    syncpackConfigPath: (workspaceRoot: string): string =>
      path.join(lintCacheDir(workspaceRoot), ROUTEKIT_EVAL_SYNCPACK_CONFIG_FILE),
  };
};

const makeRouteKitEvalDirectoryShape = (
  fs: FileSystem.FileSystem,
  path: Path.Path
): RouteKitEvalDirectoryShape => {
  const localAuthPath = (workspaceRoot: string): string =>
    path.join(workspaceRoot, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_AUTH_FILE_NAME);
  const localRunCredentialPath = (workspaceRoot: string): string =>
    path.join(
      workspaceRoot,
      ROUTEKIT_EVAL_DIRECTORY_NAME,
      ROUTEKIT_EVAL_START_CREDENTIAL_FILE_NAME
    );
  const globalAuthPath = (homeDir: string): string =>
    path.join(homeDir, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_AUTH_FILE_NAME);
  const globalCredentialFallbackPath = (homeDir: string): string =>
    path.join(homeDir, GATEWAY_DIRECTORY_NAME, ROUTEKIT_EVAL_AUTH_FILE_NAME);
  const globalWorkspaceRoot = (homeDir: string): string =>
    path.join(homeDir, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_GLOBAL_WORKSPACE_DIR);
  const globalFeaturesRoot = (homeDir: string): string =>
    path.join(globalWorkspaceRoot(homeDir), FEATURES_DIRECTORY_NAME);
  const authorContractsCacheDir = (projectRoot: string): string =>
    path.join(projectRoot, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_AUTHOR_CONTRACTS_DIRECTORY);
  const docsCacheDir = (projectRoot: string): string =>
    path.join(projectRoot, ROUTEKIT_EVAL_DIRECTORY_NAME, ROUTEKIT_EVAL_DOCS_DIRECTORY);
  const evalHistoryPath = (workspaceRoot: string): string =>
    path.join(
      workspaceRoot,
      ROUTEKIT_EVAL_DIRECTORY_NAME,
      ROUTEKIT_EVAL_DIRECTORY,
      ROUTEKIT_EVAL_HISTORY_FILE
    );
  const docsBundleCachePath = (homeDir: string, version: string): string =>
    path.join(
      homeDir,
      ROUTEKIT_EVAL_DIRECTORY_NAME,
      ROUTEKIT_EVAL_CACHE_DIR,
      ROUTEKIT_EVAL_DOCS_DIRECTORY,
      version,
      ROUTEKIT_EVAL_DOCS_BUNDLE_FILE
    );
  const workspaceRootFrom = makeWorkspaceRootFrom(fs, path);
  const authPath = makeAuthPath({
    globalAuthPath,
    localAuthPath,
    workspaceRootFrom,
  });

  return {
    ...makeLintPaths(path),
    authPath,
    authorContractsCacheDir,
    docsBundleCachePath,
    docsCacheDir,
    evalHistoryPath,
    globalAuthPath,
    globalCredentialFallbackPath,
    globalFeaturesRoot,
    globalWorkspaceRoot,
    localAuthPath,
    localRunCredentialPath,
    workspaceRootFrom,
  };
};

/**
 * The live {@link RouteKitEvalDirectory} adapter: resolves every `.routekit-eval` path against the
 * real filesystem. `FileSystem` and `Path` are acquired once in `make` so the
 * shape's methods close over them and do not leak into their own requirements
 * channel (ROUTEKIT_EVAL-331); the layer keeps `FileSystem | Path` in its requirement
 * channel rather than self-providing them, so the composition root supplies the
 * platform (`bunServicesLayer`) and tests can swap in a filesystem stub.
 */
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return RouteKitEvalDirectory.of(makeRouteKitEvalDirectoryShape(fs, path));
});

export const RouteKitEvalDirectoryLive: Layer.Layer<
  RouteKitEvalDirectory,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(RouteKitEvalDirectory)(make);
