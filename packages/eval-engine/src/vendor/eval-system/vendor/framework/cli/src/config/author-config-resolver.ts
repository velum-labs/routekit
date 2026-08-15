import type { Context, FileSystem } from "effect";

import { Effect, Path } from "effect";

import type { FeatureConfig } from "../../../contracts/author/src/feature-config.ts";

import { installFeatureConfig } from "../../../contracts/author/src/config.ts";
import { HostProcess } from "../../../contracts/internal/src/cli/host-process.ts";
import {
  globalRouteKitEvalConfigPath,
  localRouteKitEvalConfigPath,
  readMergedBlock,
  writeBlock,
} from "./config-file.ts";

/**
 * Bridge the host's Effect-based `config.json` file service to the plain-`Promise`
 * {@link FeatureConfig} the author contract exposes, mirroring
 * `makeAuthorStoreResolver`. Resolution is client-local: it reads and writes the
 * `config.json` files under the given `homeDir` / `workspaceRoot`, never a daemon
 * (RFC 0005 feature-config-access.md). A write defaults to the global scope; the
 * local scope is used only when a workspace root is available.
 */
export const makeAuthorConfigResolver = (input: {
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path>;
  readonly homeDir: string;
  readonly workspaceRoot: string | undefined;
}): FeatureConfig => {
  const runPromise = Effect.runPromiseWith(input.context);
  return {
    read: (namespace): Promise<unknown> =>
      runPromise(
        readMergedBlock({
          homeDir: input.homeDir,
          namespace,
          workspaceRoot: input.workspaceRoot,
        })
      ),
    write: (namespace, value, scope = "global"): Promise<void> =>
      runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const targetPath =
            scope === "local" && input.workspaceRoot !== undefined
              ? localRouteKitEvalConfigPath(path, input.workspaceRoot)
              : globalRouteKitEvalConfigPath(path, input.homeDir);
          yield* writeBlock({
            namespace,
            targetPath,
            value,
          });
        })
      ),
  };
};

/**
 * Build the client-local feature-config resolver from the current runtime,
 * resolving the home directory and capturing the file-system context. Callers
 * inject the result as `Chat.config` and/or install it globally.
 */
export const makeCliFeatureConfigResolver = Effect.fn("Config.makeCliResolver")(
  function* (workspaceRoot: string | undefined) {
    const hostProcess = yield* HostProcess;
    const homeDir = yield* hostProcess.homeDirectory;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    return makeAuthorConfigResolver({
      context,
      homeDir,
      workspaceRoot,
    });
  }
);

/**
 * Resolve and install the process-global feature-config resolver for the current
 * scope, so a chat surface's `start()` reaches its user-editable `config.json`
 * block through `import { config } from "routekit-eval/config"` or the injected
 * `Chat.config` (Feature Configuration Access, RFC 0005). Returns the resolver so
 * the caller can also thread it into `Chat.config`, and registers a scoped
 * finalizer that restores the prior occupant on release, mirroring
 * `installGlobalFeatureState`.
 */
export const installGlobalFeatureConfig = Effect.fn("Config.installGlobal")(
  function* (workspaceRoot: string | undefined) {
    const resolver = yield* makeCliFeatureConfigResolver(workspaceRoot);
    const restore = installFeatureConfig(resolver);
    yield* Effect.addFinalizer(() => Effect.sync(restore));
    return resolver;
  }
);
