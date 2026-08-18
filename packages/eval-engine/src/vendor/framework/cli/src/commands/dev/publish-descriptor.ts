import { Effect, FileSystem, Path } from "effect";

import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  acquireDevDescriptor,
  workspaceRootFromFeaturesRoot,
} from "../../../../runloop/local/src/dev/descriptor.ts";
import { resolveFeaturesRoot } from "../../../../runloop/local/src/feature-boot/services.ts";
import { ensureAuthorContractsCurrent } from "../init/author-contracts.ts";
import { writeDocsCache } from "../init/docs-cache.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Resolve the features root, refresh the author-contracts + docs caches, and
 * acquire (write) the `.ori/dev.json` runtime descriptor so local clients
 * (`ori tui`, `ori logs`) can discover the running daemon. Returns the workspace
 * root the descriptor was written under. Shared by `ori dev`/`ori start` (split
 * + headless paths) and `ori code`.
 */
export const publishDevDescriptor = Effect.fn("DevCommand.publishDescriptor")(
  function* (
    featuresRootInput: string,
    daemon: { readonly host: string; readonly port: number },
    options: {
      // The workspace root that anchors the descriptor + event log. Callers pass
      // it explicitly to override `dirname(featuresRoot)` — `ori code` uses the
      // launch cwd (so `ori tui`/`ori logs` discover the session, not the
      // bundle's temp dir), and `ori dev`/`start` use the resolved workspace so a
      // composed `.ori/composed` root still anchors to the declaring project.
      // Absent → derived from the features root.
      readonly descriptorWorkspaceRoot?: string | undefined;
      // `ori code` sets this: its anchor is the user's arbitrary project cwd, not
      // a feature workspace, so we don't litter it with an `.ori/docs` cache.
      // Kept separate from the anchor override — `ori dev`/`start` now always
      // pass an explicit anchor but still want the docs refresh.
      readonly skipDocsCache?: boolean;
    } = {}
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedFeaturesRoot = yield* resolveFeaturesRoot(
      fs,
      path,
      featuresRootInput
    );
    const workspaceRoot =
      options.descriptorWorkspaceRoot ??
      workspaceRootFromFeaturesRoot(path, resolvedFeaturesRoot);
    yield* ensureAuthorContractsCurrent(
      workspaceRoot,
      resolvedFeaturesRoot
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CliFailureError({
            detail: `Could not refresh author contracts in ${workspaceRoot}: ${formatUnknownError(cause)}`,
          })
      )
    );
    // Refresh the bundled docs cache (best-effort). Skipped for `ori code`: the
    // launch cwd is the user's project, not a feature workspace.
    if (!options.skipDocsCache) {
      yield* writeDocsCache(workspaceRoot).pipe(Effect.ignore);
    }
    yield* acquireDevDescriptor({
      featuresRoot: resolvedFeaturesRoot,
      host: daemon.host,
      name: path.basename(workspaceRoot),
      port: daemon.port,
      workspaceRoot,
    });
    return workspaceRoot;
  }
);
