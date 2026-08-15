import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import type { DevLogStoreContext } from "./log-store-paths.ts";

import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import { workspaceRootFromFeaturesRoot } from "./descriptor.ts";
import { listPersistedSessionMetadata } from "./log-persisted-sessions.ts";
import {
  DevLogStore,
  devLogsDir,
  listDevLogRuns,
  readDevLogRun,
  readSessionMetadata,
  resolveDevLogRunId,
} from "./log-store.ts";

/**
 * The live {@link DevLogStore} adapter: a daemon-side reader over the on-disk
 * `.routekit-eval/logs` directory. Closes over the workspace logs dir (derived from the
 * runtime's `featuresRoot`, unless an explicit workspace root is configured) and
 * the `FileSystem` / `Path` services, so the HTTP routes can read persisted run
 * files without looping back through the daemon's own streaming endpoints. When
 * no `featuresRoot` is configured, listing is empty and reads fail with a clear
 * `RuntimeServerError`.
 *
 * `FileSystem` / `Path` stay in the requirement channel (not self-provided), so
 * the composition root supplies the platform (`bunServicesLayer`) and tests can
 * swap in a filesystem stub. This is a factory rather than a bare `const` layer
 * because `featuresRoot` is a runtime binding, not a `Config` value.
 */
export const DevLogStoreLive = (
  featuresRoot?: string,
  explicitWorkspaceRoot?: string
): Layer.Layer<DevLogStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(DevLogStore)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot =
        explicitWorkspaceRoot ??
        (featuresRoot === undefined
          ? undefined
          : workspaceRootFromFeaturesRoot(path, featuresRoot));
      const context: DevLogStoreContext | null =
        workspaceRoot === undefined
          ? null
          : {
              fs,
              logsDir: devLogsDir(path, workspaceRoot),
              path,
            };
      const hasLogsDir = context !== null;

      return DevLogStore.of({
        list: () => (hasLogsDir ? listDevLogRuns(context) : Effect.succeed([])),
        read: (runId, options) =>
          hasLogsDir
            ? readDevLogRun(context, runId, options)
            : Stream.fail(
                new RuntimeServerError({
                  detail:
                    "No workspace logs directory is configured for this runtime",
                  operation: "reading dev log run",
                })
              ),
        resolve: (runId) =>
          hasLogsDir ? resolveDevLogRunId(context, runId) : Effect.succeedNone,
        readSession: (sessionId) =>
          hasLogsDir
            ? readSessionMetadata(context, sessionId)
            : Effect.succeedNone,
        listPersistedSessions: () =>
          hasLogsDir
            ? listPersistedSessionMetadata(context)
            : Effect.succeed([]),
      });
    })
  );
