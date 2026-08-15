// Keeping `.ori/eval/history.jsonl` bounded without ever handing back a history
// that is worse than the one it replaced.
//
// The prune rewrites a sibling and renames it over the history, because `rename`
// is atomic within a filesystem: a crash mid-prune leaves the previous history
// intact instead of a half-rewritten one. That reasoning only holds if the
// sibling belongs to exactly one prune. Two `ori eval` runs finishing in the same
// workspace at the same moment used to share one fixed `history.jsonl.pruning`,
// and a rename issued while the peer was still writing landed a partial file on
// top of the real history, which is the one outcome the rename exists to prevent.
import { Clock, Effect, FileSystem, Option, Path, Random } from "effect";

import {
  EVAL_HISTORY_MAX_RUNS,
  readEvalHistory,
  renderLines,
} from "./history-entry.ts";

/** Marks a file in `.ori/eval/` as a prune's scratch copy of the history. */
const PRUNE_SUFFIX = ".pruning";

/**
 * How stale a prune sibling must be before another prune deletes it.
 *
 * A sibling only outlives its prune when the process is killed between the write
 * and the rename, so anything younger than this belongs to a run that is still
 * going. Sweeping on name alone would delete a live peer's file out from under it
 * and trade this bug for a different one. An hour is far longer than a prune (one
 * write of about a hundred kilobytes) can plausibly take.
 */
const PRUNE_ORPHAN_MAX_AGE_MS = 3_600_000;

/** Exclusive upper bound on the random token that names a sibling. */
const PRUNE_TOKEN_RANGE = Number.MAX_SAFE_INTEGER;

/** Base the token is rendered in, for a shorter name than decimal. */
const PRUNE_TOKEN_RADIX = 36;

/** The prefix every prune sibling of one history file shares. */
const pruneSiblingPrefix = (historyName: string): string =>
  `${historyName}${PRUNE_SUFFIX}.`;

/**
 * Name this prune's own sibling.
 *
 * `Random` rather than a pid or a clock reading: the pid is identical for two
 * evals one process runs concurrently, and two prunes landing in the same
 * millisecond is exactly the case this exists to survive. It is also the source
 * Effect already offers, so the platform-boundary audit stays untouched.
 */
const pruneSiblingPath = Effect.fn("EvalHistory.pruneSibling")(function* (
  historyPath: string
) {
  const path = yield* Path.Path;
  const token = yield* Random.nextIntBetween(0, PRUNE_TOKEN_RANGE, {
    halfOpen: true,
  });
  const prefix = pruneSiblingPrefix(path.basename(historyPath));
  return path.join(
    path.dirname(historyPath),
    `${prefix}${token.toString(PRUNE_TOKEN_RADIX)}`
  );
});

/**
 * Delete one sibling that no live prune can still own.
 *
 * Every step is discarded: a peer that renamed its sibling away between the
 * listing and the stat is the normal case rather than a problem, and a sibling
 * whose mtime the platform does not report is left alone rather than guessed at.
 */
const removeAbandonedSibling = Effect.fn("EvalHistory.removeAbandoned")(
  function* (input: { readonly now: number; readonly path: string }) {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(input.path).pipe(Effect.option);
    if (Option.isNone(info)) {
      return;
    }
    const { mtime } = info.value;
    if (
      Option.isNone(mtime) ||
      input.now - mtime.value.getTime() < PRUNE_ORPHAN_MAX_AGE_MS
    ) {
      return;
    }
    yield* fs.remove(input.path, { force: true }).pipe(Effect.ignore);
  }
);

/**
 * Sweep siblings left behind by a run killed between its write and its rename.
 *
 * Unique names fix the race but would otherwise turn the leftover from one
 * predictable file the next run overwrote into an unbounded pile in someone's
 * `.ori/`, so the prune that used to do the overwriting clears them instead.
 */
const removeAbandonedSiblings = Effect.fn("EvalHistory.sweep")(function* (
  historyPath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(historyPath);
  const prefix = pruneSiblingPrefix(path.basename(historyPath));
  const names = yield* fs.readDirectory(directory).pipe(Effect.option);
  if (Option.isNone(names)) {
    return;
  }
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.forEach(
    names.value.filter((name) => name.startsWith(prefix)),
    (name) =>
      removeAbandonedSibling({
        now,
        path: path.join(directory, name),
      }),
    { discard: true }
  );
});

/**
 * Bound the file to the most recent {@link EVAL_HISTORY_MAX_RUNS} runs.
 *
 * `wx` on the write and the removal on the way out are the two halves of owning
 * the sibling's name: nothing else can be sharing the file, and nothing is left
 * behind when the write or the rename fails. A token collision therefore costs a
 * skipped prune rather than a shared file, and the caller already treats a
 * skipped prune as fine.
 */
export const pruneEvalHistory = Effect.fn("EvalHistory.prune")(function* (
  historyPath: string
) {
  const entries = yield* readEvalHistory(historyPath);
  if (entries.length <= EVAL_HISTORY_MAX_RUNS) {
    return;
  }
  yield* removeAbandonedSiblings(historyPath).pipe(Effect.ignore);
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* pruneSiblingPath(historyPath);
  yield* Effect.ensuring(
    Effect.gen(function* () {
      yield* fs.writeFileString(
        temporary,
        renderLines(entries.slice(entries.length - EVAL_HISTORY_MAX_RUNS)),
        { flag: "wx" }
      );
      yield* fs.rename(temporary, historyPath);
    }),
    fs.remove(temporary, { force: true }).pipe(Effect.ignore)
  );
});

export { PRUNE_SUFFIX, pruneSiblingPrefix };
