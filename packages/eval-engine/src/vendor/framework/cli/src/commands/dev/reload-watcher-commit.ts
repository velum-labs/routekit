import { Cause, Context, Effect, Option } from "effect";

import type {
  CliIoError,
  RuntimeServerError,
} from "../../../../contracts/internal/src/errors.ts";
import type { FeatureBootResult } from "../../../../runloop/local/src/feature-boot/types.ts";
import type { WatcherDeps } from "./reload-watcher-snapshot.ts";

import {
  formatError,
  formatInfo,
  formatWarning,
} from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { HarnessWorkspaceMaterializer } from "../../../../runloop/local/src/agent-runner/index.ts";
import { FeatureCatalog } from "../../../../runloop/local/src/catalog/feature.ts";
import { workspaceRootFromFeaturesRoot } from "../../../../runloop/local/src/dev/descriptor.ts";
import { resolveFeaturesRoot } from "../../../../runloop/local/src/feature-boot/services.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

// Materialize the boot's skill set into a snapshot generation as part of the
// reload transaction (not lazily at the next invoke), so the on-disk skill
// views swap together with the in-memory composed state, and materialization
// failures surface as reload diagnostics instead of exploding on the next
// user message.
const materializeSnapshotEffect = Effect.fn(
  "DevReloadWatcher.materializeSnapshot"
)(function* (deps: WatcherDeps, boot: FeatureBootResult) {
  const materializer = yield* HarnessWorkspaceMaterializer;
  const resolvedRoot = yield* resolveFeaturesRoot(
    deps.fs,
    deps.path,
    deps.featuresRoot
  );
  const workspace = yield* materializer.prepare({
    cwd: workspaceRootFromFeaturesRoot(deps.path, resolvedRoot),
    featuresRoot: resolvedRoot,
    skills: boot.skillEntries,
    workspaceFeatureIds: Context.get(deps.daemonContext, FeatureCatalog)
      .workspaceFeatureIds,
  });
  // Surface skill-link reconciliation warnings (e.g. a foreign symlink left
  // untouched) on reload, matching the agent-runner path; otherwise `ori dev`
  // would silently drop feedback that `ori code`/`ori chat` show.
  for (const warning of workspace.warnings) {
    yield* deps.cliIo.writeStderr(`${formatWarning(`reload: ${warning}`)}\n`);
  }
  yield* deps.cliIo.writeStderr(
    `${formatInfo(`reload: snapshot ${workspace.generation} ready (${workspace.skillCount} skill(s))`)}\n`
  );
});

const materializeSnapshot = (
  deps: WatcherDeps,
  boot: FeatureBootResult
): Effect.Effect<
  void,
  CliIoError | RuntimeServerError,
  HarnessWorkspaceMaterializer
> =>
  materializeSnapshotEffect(deps, boot).pipe(
    Effect.provide(deps.daemonContext)
  );

// Undo the on-disk snapshot swap after a failed commit by re-materializing the
// last-good boot. When there is no last-good boot (the very first reload, before
// `bootstrapInitialReload` recorded one — normally impossible, since bootstrap
// runs before the watcher starts), there is no committed generation to roll back
// to, so leave the freshly materialized snapshot in place and only report the
// gap. A rollback that itself fails must not mask the original commit cause, so
// its failure is logged and swallowed.
const rollbackMaterializedSnapshot = Effect.fn(
  "DevReloadWatcher.rollbackMaterializedSnapshot"
)(function* (
  deps: WatcherDeps,
  previousBoot: Option.Option<FeatureBootResult>,
  commitCause: Cause.Cause<unknown>
) {
  yield* deps.cliIo
    .writeStderr(
      `${formatWarning(`reload: commit failed after snapshot swap (${formatUnknownError(Cause.squash(commitCause))}); rolling back on-disk snapshot`)}\n`
    )
    .pipe(Effect.ignore);
  if (Option.isNone(previousBoot)) {
    yield* deps.cliIo
      .writeStderr(
        `${formatWarning("reload: no last-good snapshot to roll back to; on-disk snapshot may be ahead of the committed runtime")}\n`
      )
      .pipe(Effect.ignore);
    return;
  }
  yield* materializeSnapshot(deps, previousBoot.value).pipe(
    Effect.catchCause((rollbackCause) =>
      deps.cliIo
        .writeStderr(
          `${formatError(`reload: snapshot rollback failed (${formatUnknownError(Cause.squash(rollbackCause))}); on-disk snapshot may be ahead of the committed runtime`)}\n`
        )
        .pipe(Effect.ignore)
    )
  );
});

// Materialize the new boot's snapshot and then commit it as one all-or-nothing
// transaction. `materializeSnapshot` swaps the on-disk `current` snapshot to the
// new generation; `commit` swaps the in-memory composed generation. These two
// must succeed or fail together: if `commit` fails or dies *after* the disk
// swap, the on-disk skill views would be one generation ahead of the committed
// runtime and `lastGoodBoot` would never advance — a silent divergence that
// leaks into the next `/api/invoke`. On a genuine commit failure (error or
// defect) we re-materialize the last-good boot to roll the disk snapshot back to
// the committed generation (re-materialization is idempotent by fingerprint, so
// it just re-swaps `current` back to the retained previous generation), then
// re-raise as a *typed* `CliFailureError` so `drainAndReload`'s `Effect.catch`
// treats it as a rejected reload (keeps the last-good runtime running) instead of
// letting a raw defect escape and kill the watcher fiber. `prepared.commit` is
// typed `Effect<void>`, so a real commit failure surfaces as a defect —
// converting it here is what keeps the failure recoverable and the half-applied
// boot out of `lastGoodBoot`.
//
// Fiber INTERRUPTION is deliberately excluded: it is not a commit failure but a
// shutdown signal, so it propagates unchanged (no rollback, no error conversion)
// — see the `Cause.hasInterruptsOnly` guard below.
const materializeThenCommit = Effect.fn(
  "DevReloadWatcher.materializeThenCommit"
)(function* (
  deps: WatcherDeps,
  input: {
    readonly boot: FeatureBootResult;
    readonly commit: Effect.Effect<void>;
    readonly previousBoot: Option.Option<FeatureBootResult>;
  }
) {
  yield* materializeSnapshot(deps, input.boot).pipe(
    Effect.mapError(
      (error) =>
        new CliFailureError({
          detail: `snapshot materialization failed: ${formatUnknownError(error)}`,
        })
    )
  );
  // Fiber interruption is NOT a commit failure: when the watcher fiber is
  // interrupted (a clean `ori dev` exit / process shutdown), the interruption
  // must propagate unchanged so structured concurrency tears the fiber down —
  // we do not run a disk rollback during shutdown, and we never convert it to a
  // `CliFailureError`. `Effect.catchCause` sees interruption too, so guard on
  // `Cause.hasInterruptsOnly` and re-raise the original cause in that case.
  yield* input.commit.pipe(
    Effect.catchCause((commitCause) =>
      Cause.hasInterruptsOnly(commitCause)
        ? Effect.failCause(commitCause)
        : rollbackMaterializedSnapshot(
            deps,
            input.previousBoot,
            commitCause
          ).pipe(
            Effect.andThen(
              new CliFailureError({
                detail: `reload commit failed after snapshot swap: ${formatUnknownError(Cause.squash(commitCause))}`,
              })
            )
          )
    )
  );
});

export { materializeSnapshot, materializeThenCommit };
