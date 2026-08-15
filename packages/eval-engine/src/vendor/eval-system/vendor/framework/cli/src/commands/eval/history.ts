// Making an `routekit-eval eval` run outlive the command. The results channel
// (`results.ts`) writes into a scoped temp dir that is removed when the command's
// scope closes, which is what makes it crash-tolerant and what every existing
// test asserts against. This is a layer above that file, not a replacement: once
// the rows have been read back, one summary line per run is appended to
// `.routekit/eval/history.jsonl` in the workspace, so a pass rate can be watched over
// time instead of scrolling past once.
//
// A summary rather than the rows themselves. A row forwards `payload: Unknown`
// verbatim from whichever harness ran, which carries model output and provider
// error text of unbounded size; persisting that into a user's project directory
// is a different decision with different privacy consequences than recording a
// number, and it is not the one this file makes. Counts, timings, cost, and model
// ids are what "watch the number move" needs.
//
// The line's shape and the reader live in `history-entry.ts`; bounding the file
// lives in `history-prune.ts`.
import { Effect, FileSystem, Option, Path } from "effect";

import type {
  EvalHistoryEntry,
  EvalHistoryModelSchema,
} from "./history-entry.ts";
import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";

import {
  EVAL_HISTORY_MAX_RUNS,
  EvalHistoryEntrySchema,
  encodeEntry,
  normalizeEvalFiles,
  readEvalHistory,
} from "./history-entry.ts";
import { pruneEvalHistory } from "./history-prune.ts";
import {
  isCandidateRun,
  isCompletedRun,
  isFailedRun,
  rowCostUsd,
  runModel,
  totalCostUsd,
} from "./results.ts";
import { RouteKitEvalDirectory } from "../../routekit-eval-directory.ts";

/**
 * Add two costs where "absent" is not zero.
 *
 * A run in which no harness reported spend must stay absent all the way into the
 * file; starting the accumulator at `0` would report every such run as free.
 */
const addCost = (
  total: number | undefined,
  next: number | undefined
): number | undefined => {
  if (next === undefined) {
    return total;
  }
  return (total ?? 0) + next;
};

interface ModelAccumulator {
  costUsd: number | undefined;
  failedRuns: number;
  runs: number;
}

/**
 * Roll the rows up per model, in the order the models first answered.
 *
 * Insertion order rather than sorted, so two runs of the same eval produce the
 * same model order and a later diff of two entries lines up.
 */
const summarizeModels = (
  results: readonly EvalResultRow[]
): readonly (typeof EvalHistoryModelSchema.Type)[] => {
  const byModel = new Map<string, ModelAccumulator>();
  for (const row of results) {
    const model = runModel(row);
    const accumulated = byModel.get(model) ?? {
      costUsd: undefined,
      failedRuns: 0,
      runs: 0,
    };
    byModel.set(model, {
      costUsd: addCost(accumulated.costUsd, rowCostUsd(row)),
      failedRuns: accumulated.failedRuns + (isFailedRun(row) ? 1 : 0),
      runs: accumulated.runs + 1,
    });
  }
  return [...byModel].map(([model, accumulated]) => ({
    ...(accumulated.costUsd === undefined
      ? {}
      : { costUsd: accumulated.costUsd }),
    failedRuns: accumulated.failedRuns,
    model,
    runs: accumulated.runs,
  }));
};

const countStatus = (
  tests: readonly EvalTestRow[],
  status: EvalTestRow["status"]
): number => tests.filter((test) => test.status === status).length;

/**
 * Project a finished run onto the one line the history keeps. Pure, and separate
 * from the write, so the shape of what gets recorded is testable without a
 * filesystem and the write stays about durability.
 *
 * Judge runs are dropped before any of this. The history answers "is this model
 * getting better, and what does it cost", and the grader is neither a model under
 * evaluation nor a cost anyone is trying to compare — on the bakeoff that prompted
 * this it was 98.9% of the spend, which made every recorded cost a fact about the
 * grader. Filtered here rather than accommodated in the entry, because the entry
 * shape is what `--baseline` compares against run to run and it stays frozen. A
 * run made entirely of judge calls therefore records `runs: 0` and no models,
 * which is the honest count: nothing was evaluated.
 *
 * Runs that were cut off are dropped for the same reason and by the same means:
 * filtered here rather than accommodated in the frozen entry shape. `runs` counts
 * COMPLETED agent runs, which is what `--baseline` has always compared, and a
 * candidate killed mid-flight has no cost, no duration, and no terminal event to
 * contribute. Counting it would be worse than losing it: it would enter the
 * denominator of `failedRuns / runs` without ever entering the numerator, so a run
 * that lost half its candidates to a thrown assertion would read as a drop in the
 * failure rate. The cut-off runs stay visible in the report and in `data.results`,
 * which is where a reader looks at one run rather than at a series.
 *
 * `files` is the run's resolved targets, taken from discovery rather than from the
 * test rows. A spawn failure or a missing credential produces zero test rows, and
 * that is precisely the run that must not record an empty scope and then match
 * every later run of anything.
 */
export const summarizeEvalRun = (input: {
  readonly exitCode: number;
  readonly files: readonly string[];
  readonly recordedAt: string;
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): EvalHistoryEntry => {
  const candidates = input.results
    .filter(isCandidateRun)
    .filter(isCompletedRun);
  const costUsd = totalCostUsd(candidates);
  return {
    ...(costUsd === undefined ? {} : { costUsd }),
    exitCode: input.exitCode,
    failedRuns: candidates.filter(isFailedRun).length,
    files: normalizeEvalFiles(input.files),
    models: summarizeModels(candidates),
    recordedAt: input.recordedAt,
    runs: candidates.length,
    tests: {
      failed: countStatus(input.tests, "fail"),
      passed: countStatus(input.tests, "pass"),
      skipped: countStatus(input.tests, "skipped"),
    },
  };
};

/**
 * The run's eval files as the history names them: relative to the workspace root,
 * with `/` separators.
 *
 * Relative because the same checkout cloned to a second path is the same suite,
 * and an absolute path would make every run there incomparable to the runs before
 * it. `/` because the recorded set is compared as text and a history written on
 * Windows must still match one written anywhere else.
 *
 * No workspace root means nothing is recorded and nothing is compared, so the
 * empty answer is never written down.
 */
export const evalRunFiles = Effect.fn("EvalHistory.files")(function* (input: {
  readonly files: readonly string[];
  readonly workingDirectory: string;
}) {
  const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
  const path = yield* Path.Path;
  const workspaceRoot = yield* routeKitEvalDirectory.workspaceRootFrom(
    input.workingDirectory
  );
  if (Option.isNone(workspaceRoot)) {
    return [] as readonly string[];
  }
  return input.files.map((file) =>
    path.relative(workspaceRoot.value, file).split(path.sep).join("/")
  );
});

/**
 * Append this run to the history, then bound the file.
 *
 * Takes the projected entry rather than the raw rows, so the caller stamps
 * `recordedAt` once and the same entry is both compared against the baseline and
 * written down. Two timestamps for one run would put a value in the file that
 * nothing else in the command ever saw.
 *
 * Appended before pruning so the new line is durable on disk before the rewrite
 * that could truncate anything, and the whole thing is discarded on any outcome
 * but success — including a defect. Recording history is a convenience layered
 * over the run; a full disk, a read-only checkout, or a path that turned out to
 * be a directory degrades to "no history this time" and must never turn a passing
 * eval into a failing one.
 */
export const recordEvalRun = Effect.fn("EvalHistory.record")(
  function* (input: {
    readonly entry: EvalHistoryEntry;
    readonly historyPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const line = encodeEntry(input.entry);
    if (Option.isNone(line)) {
      return;
    }
    yield* fs.makeDirectory(path.dirname(input.historyPath), {
      recursive: true,
    });
    yield* fs.writeFileString(input.historyPath, `${line.value}\n`, {
      flag: "a",
    });
    yield* pruneEvalHistory(input.historyPath);
  },
  (effect) => Effect.ignoreCause(effect)
);

/**
 * Record the run against the workspace the eval ran in, when there is one.
 *
 * No workspace root at or above the eval directory means no history is written at
 * all, which keeps `routekit-eval eval` in a bare directory exactly as silent as it was
 * before this file existed. The history lives in the workspace rather than in
 * `~/.routekit-eval` because a pass rate is a fact about one project's evals, and a shared
 * global series would interleave unrelated projects into one meaningless number.
 */
export const recordEvalRunForWorkspace = Effect.fn("EvalHistory.recordForRun")(
  function* (input: {
    readonly enabled: boolean;
    readonly entry: EvalHistoryEntry;
    readonly workingDirectory: string;
  }) {
    if (!input.enabled) {
      return;
    }
    const routeKitEvalDirectory = yield* RouteKitEvalDirectory;
    const workspaceRoot = yield* routeKitEvalDirectory.workspaceRootFrom(
      input.workingDirectory
    );
    if (Option.isNone(workspaceRoot)) {
      return;
    }
    yield* recordEvalRun({
      entry: input.entry,
      historyPath: routeKitEvalDirectory.evalHistoryPath(workspaceRoot.value),
    });
  }
);

export { EVAL_HISTORY_MAX_RUNS, EvalHistoryEntrySchema, readEvalHistory };
export type { EvalHistoryEntry };
