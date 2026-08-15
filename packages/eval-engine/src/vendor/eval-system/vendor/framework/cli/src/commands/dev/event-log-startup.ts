import type { FileSystem, Path } from "effect";

import { Effect, Option } from "effect";

import type { DevLogRetentionPolicy } from "../../../../runloop/local/src/dev/log-store.ts";

import { pruneOrphanedSessionSidecars } from "../../../../runloop/local/src/dev/log-sessions.ts";
import {
  devLogRunIdFromPath,
  pruneDevLogRuns,
} from "../../../../runloop/local/src/dev/log-store.ts";

const MIN_POSITIVE = 0;
const ROUTEKIT_EVAL_GITIGNORE_FILE = ".gitignore";
const ROUTEKIT_EVAL_GITIGNORE_ENTRY = "*";

export const ensureRouteKitEvalDirectoryGitignore = Effect.fn(
  "DevCommand.ensureRouteKitEvalDirectoryGitignore"
)(function* (fs: FileSystem.FileSystem, path: Path.Path, routeKitEvalDirectory: string) {
  const ignorePath = path.join(routeKitEvalDirectory, ROUTEKIT_EVAL_GITIGNORE_FILE);
  const existing = yield* fs.readFileString(ignorePath).pipe(Effect.option);
  if (Option.isNone(existing)) {
    yield* fs.writeFileString(ignorePath, `${ROUTEKIT_EVAL_GITIGNORE_ENTRY}\n`);
    return;
  }
  if (existing.value.split(/\r?\n/gu).includes(ROUTEKIT_EVAL_GITIGNORE_ENTRY)) {
    return;
  }
  const separator = existing.value.endsWith("\n") ? "" : "\n";
  yield* fs.writeFileString(
    ignorePath,
    `${existing.value}${separator}${ROUTEKIT_EVAL_GITIGNORE_ENTRY}\n`
  );
});

interface PrepareDevLogStorageInput {
  readonly filePath: string;
  readonly fs: FileSystem.FileSystem;
  readonly logsDir: string;
  readonly path: Path.Path;
  readonly policy: Effect.Effect<DevLogRetentionPolicy>;
  readonly publishLog?: ((line: string) => void) | undefined;
}

/**
 * Bound `.routekit-eval/logs` before streaming so runs don't pile up over time. Runs
 * after the new file exists (so it's always retained as the active run) and
 * is best-effort — pruning never blocks or fails the session.
 */
export const prepareDevLogStorage = Effect.fn(
  "DevCommand.prepareDevLogStorage"
)(function* (input: PrepareDevLogStorageInput) {
  yield* ensureRouteKitEvalDirectoryGitignore(
    input.fs,
    input.path,
    input.path.dirname(input.logsDir)
  ).pipe(Effect.ignore);
  const storeContext = {
    fs: input.fs,
    logsDir: input.logsDir,
    path: input.path,
  };
  const removed = yield* pruneDevLogRuns(storeContext, {
    keepRunId: devLogRunIdFromPath(input.path, input.filePath),
    policy: yield* input.policy,
  });
  if (removed.length > MIN_POSITIVE) {
    input.publishLog?.(
      `[routekit-eval-runtime] pruned ${removed.length} old event-log run(s) from ${input.logsDir}`
    );
  }
  // Prune session sidecars orphaned by the run prune above: a sidecar is
  // derived from run files, so it must not outlive every run it was projected
  // from (RFC 0004 sessions.md "Session metadata"). Best-effort, same as the run
  // prune — a failed sidecar delete never takes down the session.
  yield* pruneOrphanedSessionSidecars(storeContext);
});
