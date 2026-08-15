import { Effect, FileSystem, Option, Path } from "effect";

import type { DevLogStoreContext } from "./log-store.ts";

import { listPersistedSessionMetadata } from "./log-persisted-sessions.ts";
import {
  devLogsDir,
  listDevLogRuns,
  readRunEntries,
  sessionsDir,
} from "./log-store.ts";

const EMPTY_COUNT = 0;

/**
 * List the session ids a run file references, by scanning its `runtime.event`
 * records for hoisted, non-null `sessionId`s. Used by the retention pass to
 * decide which sidecars are still backed by a surviving run.
 */
const sessionIdsInRun = Effect.fn("DevLogStore.sessionIdsInRun")(function* (
  context: DevLogStoreContext,
  runId: string
) {
  const entries = yield* readRunEntries(context, runId);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "runtime.event" && entry.sessionId !== null) {
      ids.add(entry.sessionId);
    }
  }
  return ids;
});

/**
 * List the session ids that currently have a sidecar directory under
 * `.routekit-eval/logs/sessions/`. Each entry is a `<sessionId>/` directory holding a
 * `metadata.json`. Best-effort: a missing/unreadable sessions dir yields `[]`.
 */
export const listSessionSidecarIds = Effect.fn(
  "DevLogStore.listSessionSidecarIds"
)(function* (context: DevLogStoreContext) {
  const { fs, path, logsDir } = context;
  const dir = sessionsDir(logsDir, path);
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as readonly string[];
  }
  return yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
});

/**
 * Remove one session's sidecar directory (`sessions/<id>/`) recursively,
 * best-effort — a failed delete never propagates.
 */
const removeSessionSidecar = Effect.fn("DevLogStore.removeSessionSidecar")(
  function* (context: DevLogStoreContext, sessionId: string) {
    const { fs, path, logsDir } = context;
    yield* fs
      .remove(path.join(sessionsDir(logsDir, path), sessionId), {
        recursive: true,
      })
      .pipe(Effect.ignore);
  }
);

/**
 * Best-effort removal of session sidecars that no surviving run references. The
 * `sessions/<id>/` sidecars are derived projections over the run files (RFC
 * 0004 sessions.md "Session metadata"), so a sidecar MUST NOT outlive every run it
 * was projected from: when the last run referencing a sessionId is dropped,
 * remove that session's sidecar. This unions the session ids referenced by the
 * *surviving* run files and deletes any sidecar directory whose session id is
 * not in that set — so a sidecar survives iff some retained run still mentions
 * it (a sidecar outlives any single run, just not every run). Run separately
 * from `pruneDevLogRuns` (which owns run-file retention) and called after it,
 * so each stays a single responsibility. Fully best-effort: a missing sessions
 * dir or a failed delete never propagates.
 */
export const pruneOrphanedSessionSidecars = Effect.fn(
  "DevLogStore.pruneOrphanedSessionSidecars"
)(function* (context: DevLogStoreContext) {
  const sidecarIds = yield* listSessionSidecarIds(context);
  if (sidecarIds.length === EMPTY_COUNT) {
    return [] as readonly string[];
  }

  const runs = yield* listDevLogRuns(context);
  const idSets = yield* Effect.forEach(
    runs,
    (run) => sessionIdsInRun(context, run.id),
    { concurrency: "unbounded" }
  );
  const referenced = new Set<string>();
  for (const ids of idSets) {
    for (const id of ids) {
      referenced.add(id);
    }
  }

  const orphaned = sidecarIds.filter((id) => !referenced.has(id));
  yield* Effect.forEach(orphaned, (id) => removeSessionSidecar(context, id), {
    concurrency: "unbounded",
  });
  return orphaned;
});

/**
 * List every persisted session sidecar under `.routekit-eval/logs/sessions/`, newest
 * first (sorted by `endedAt`, ISO-8601, descending). Delegates to the leaf
 * reader so this module and `DevLogStore` (which cannot import this module
 * without a cycle) share one implementation.
 */
export const listPersistedSessions = Effect.fn(
  "DevLogStore.listPersistedSessions"
)(function* (context: DevLogStoreContext) {
  return yield* listPersistedSessionMetadata(context);
});

/**
 * Resolve the most recently active session id from the persisted sidecars under
 * `.routekit-eval/logs/sessions/`, or `None` when there is nothing to resume. Reads go
 * through the disk reader (not the in-memory registry), so it works before any
 * daemon boots — which is what `routekit-eval code --resume` needs: it resolves the id to
 * hand to the child `routekit-eval tui` before starting its own runtime. Best-effort: an
 * unreadable or unparseable sidecar is skipped rather than failing the resolve.
 */
export const resolveLatestSessionId = Effect.fn(
  "DevLogStore.resolveLatestSessionId"
)(function* (context: DevLogStoreContext) {
  // `listPersistedSessions` returns sidecars newest-first, so the head is the
  // most recently active session.
  const [latest] = yield* listPersistedSessions(context);
  if (latest === undefined) {
    return Option.none<string>();
  }
  return Option.some<string>(latest.sessionId);
});

/**
 * Resolve the latest resumable session id for a workspace root, building the
 * disk-reader context from the workspace's `.routekit-eval/logs` directory. This is the
 * seam `routekit-eval code --resume` calls: it owns the launch cwd (not a daemon
 * `featuresRoot`), so it constructs the context here rather than through
 * {@link DevLogStore}.
 */
export const resolveLatestSessionIdInWorkspace = Effect.fn(
  "DevLogStore.resolveLatestSessionIdInWorkspace"
)(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* resolveLatestSessionId({
    fs,
    logsDir: devLogsDir(path, workspaceRoot),
    path,
  });
});
