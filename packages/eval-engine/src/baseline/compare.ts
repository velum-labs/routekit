// "Did this get worse than the thing I trust." The history (`history.ts`) answers
// what a run scored; this file answers whether that score moved the wrong way
// against a run worth comparing to. Nothing here writes: the baseline is chosen
// out of the summaries already on disk, so no second store exists and no entry
// shape changes.
//
// One rule runs through the whole file. A measurement that is absent is not a
// measurement of zero, so every comparison is between two numbers that both
// exist, and a metric missing on either side is dropped rather than defaulted.
// The alternative reports a fake regression the moment a harness goes quiet or a
// model appears in one run and not the other, which would teach people to stop
// reading the line.
import { Array as Arr, Option, pipe, Schema } from "effect";
import { comparableEvalRuns } from "../baseline/scope.js";
import type { EvalBaselineSelector } from "../baseline/selector.js";
import { describeEvalBaselineSelector } from "../baseline/selector.js";
import type { EvalHistoryEntry } from "../history/index.js";

/**
 * Rates are ratios of small integers, so two runs that scored identically can
 * still differ in the last bits of the division. Only a move wider than this
 * counts as a move at all.
 */
const RATE_EPSILON = 1e-9;

/**
 * One metric's move, and only ever between two numbers that both exist.
 * {@link metricDelta} is the sole constructor, which is what keeps "absent" from
 * decaying into `0` anywhere downstream.
 */
const EvalMetricDeltaSchema = Schema.Struct({
  baseline: Schema.Finite,
  current: Schema.Finite,
  delta: Schema.Finite
});

type EvalMetricDelta = typeof EvalMetricDeltaSchema.Type;

/** What can be called worse. Cost is deliberately not on this list. */
const EvalRegressionKindSchema = Schema.Literals(["pass-rate", "failed-run-rate"]);

type EvalRegressionKind = typeof EvalRegressionKindSchema.Type;

/**
 * One model's move between the two runs.
 *
 * Failed-run rate and cost only: the history keeps its test census at the run
 * level, not per model, so a per-model pass rate is not derivable from an entry
 * and this does not invent one.
 */
const EvalModelComparisonSchema = Schema.Struct({
  costUsd: Schema.optional(EvalMetricDeltaSchema),
  failedRunRate: Schema.optional(EvalMetricDeltaSchema),
  model: Schema.String
});

/**
 * The verdict.
 *
 * `regressions` carries the run-level metrics that moved the wrong way, and is
 * empty when nothing did. The two `notMeasuredIn*` lists name models that only
 * one of the runs exercised; they are reported so a reader knows the comparison
 * is partial, and are never regressions, because a model that did not run did not
 * score zero.
 */
const EvalComparisonSchema = Schema.Struct({
  baselineRecordedAt: Schema.String,
  costUsd: Schema.optional(EvalMetricDeltaSchema),
  failedRunRate: Schema.optional(EvalMetricDeltaSchema),
  models: Schema.Array(EvalModelComparisonSchema),
  notMeasuredInBaseline: Schema.Array(Schema.String),
  notMeasuredInCurrent: Schema.Array(Schema.String),
  passRate: Schema.optional(EvalMetricDeltaSchema),
  regressions: Schema.Array(EvalRegressionKindSchema),
  selector: Schema.String
});

type EvalComparison = typeof EvalComparisonSchema.Type;

/**
 * Share of measured tests that passed.
 *
 * Skipped tests are excluded from the denominator rather than counted as
 * failures: a skipped test was not measured, and folding it in either direction
 * reports a movement that never happened. A run in which nothing was measured has
 * no pass rate at all, which is why this can answer `undefined`.
 */
const passRate = (entry: EvalHistoryEntry): number | undefined => {
  const measured = entry.tests.passed + entry.tests.failed;
  return measured === 0 ? undefined : entry.tests.passed / measured;
};

/** Share of agent runs that failed outright, absent when nothing ran. */
const failedRunRate = (counts: {
  readonly failedRuns: number;
  readonly runs: number;
}): number | undefined => (counts.runs === 0 ? undefined : counts.failedRuns / counts.runs);

/** The one place two measurements become a delta, and only when both exist. */
const metricDelta = (
  baseline: number | undefined,
  current: number | undefined
): EvalMetricDelta | undefined =>
  baseline === undefined || current === undefined
    ? undefined
    : {
        baseline,
        current,
        delta: current - baseline
      };

const dropped = (delta: EvalMetricDelta | undefined): boolean =>
  delta !== undefined && delta.delta < -RATE_EPSILON;

const rose = (delta: EvalMetricDelta | undefined): boolean =>
  delta !== undefined && delta.delta > RATE_EPSILON;

const compareModels = (
  baseline: EvalHistoryEntry,
  current: EvalHistoryEntry
): readonly (typeof EvalModelComparisonSchema.Type)[] => {
  const baselineByModel = new Map(baseline.models.map((model) => [model.model, model]));
  return Arr.getSomes(
    current.models.map((model) => {
      const before = baselineByModel.get(model.model);
      if (before === undefined) {
        return Option.none();
      }
      const cost = metricDelta(before.costUsd, model.costUsd);
      const failed = metricDelta(failedRunRate(before), failedRunRate(model));
      return Option.some({
        ...(cost === undefined ? {} : { costUsd: cost }),
        ...(failed === undefined ? {} : { failedRunRate: failed }),
        model: model.model
      });
    })
  );
};

/** Models one run exercised and the other did not, in first-answered order. */
const modelsMissingFrom = (
  present: EvalHistoryEntry,
  absent: EvalHistoryEntry
): readonly string[] => {
  const absentModels = new Set(absent.models.map((model) => model.model));
  return present.models.map((model) => model.model).filter((model) => !absentModels.has(model));
};

/**
 * Compare two runs.
 *
 * Pass rate and failed-run rate carry the verdict; cost is reported and never
 * counted, because spending more to answer better is a trade someone chose rather
 * than a regression, and calling it one would train people to ignore the line.
 */
export const compareEvalRun = (input: {
  readonly baseline: EvalHistoryEntry;
  readonly current: EvalHistoryEntry;
  readonly selector: EvalBaselineSelector;
}): EvalComparison => {
  const { baseline, current } = input;
  const pass = metricDelta(passRate(baseline), passRate(current));
  const failed = metricDelta(failedRunRate(baseline), failedRunRate(current));
  const cost = metricDelta(baseline.costUsd, current.costUsd);
  const regressions: EvalRegressionKind[] = [];
  if (dropped(pass)) {
    regressions.push("pass-rate");
  }
  if (rose(failed)) {
    regressions.push("failed-run-rate");
  }
  return {
    baselineRecordedAt: baseline.recordedAt,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(failed === undefined ? {} : { failedRunRate: failed }),
    models: compareModels(baseline, current),
    notMeasuredInBaseline: modelsMissingFrom(current, baseline),
    notMeasuredInCurrent: modelsMissingFrom(baseline, current),
    ...(pass === undefined ? {} : { passRate: pass }),
    regressions,
    selector: describeEvalBaselineSelector(input.selector)
  };
};

/**
 * Highest pass rate in the history, most recent winning a tie.
 *
 * Runs that measured nothing are passed over rather than treated as a zero-scoring
 * high-water mark, which would make every later run look like a regression.
 */
const bestByPassRate = (history: readonly EvalHistoryEntry[]): Option.Option<EvalHistoryEntry> => {
  let best: EvalHistoryEntry | undefined;
  let bestRate: number | undefined;
  for (const entry of history) {
    const rate = passRate(entry);
    if (rate === undefined) {
      continue;
    }
    if (bestRate === undefined || rate >= bestRate) {
      best = entry;
      bestRate = rate;
    }
  }
  return best === undefined ? Option.none() : Option.some(best);
};

/**
 * Pick the run to compare against out of the runs recorded before this one.
 *
 * Scoped to the same eval files first, so every selector answers within one
 * suite. Scoping only `last` would leave `best` and `model:<slug>` reaching across
 * unrelated evals, which is the same bug wearing a different flag.
 *
 * `Option.none()` whenever nothing matches, which covers a first run in a fresh
 * workspace, a `model:` slug that has never been evaluated here, and a workspace
 * whose earlier runs covered other files. None of those are errors.
 */
export const selectEvalBaseline = (input: {
  readonly files: readonly string[];
  readonly history: readonly EvalHistoryEntry[];
  readonly selector: EvalBaselineSelector;
}): Option.Option<EvalHistoryEntry> => {
  const history = comparableEvalRuns(input.history, input.files);
  const { selector } = input;
  if (selector.kind === "model") {
    return pipe(
      history,
      Arr.findLast((entry) => entry.models.some((model) => model.model === selector.model))
    );
  }
  if (selector.kind === "best") {
    return bestByPassRate(history);
  }
  return Arr.last(history);
};

/**
 * Why a run came back without a comparison.
 *
 * Four different facts, and only two of them warrant silence. `none-yet` is a
 * workspace whose history is empty, which the next run fixes on its own.
 * `scoped-out` is a workspace with history that measured other eval files, so a
 * reader shown nothing would read a correctly scoped baseline as a broken one.
 * `no-workspace` can never fix itself: no run is recorded outside an RouteKit Eval
 * workspace, so `--baseline` has nothing to compare against here and never will.
 * `recording-disabled` is that same directory with `--no-history`, which is
 * someone asking for exactly this and must not be nagged about it.
 *
 * One reason rather than a flag per case: the cases are exclusive, and parallel
 * booleans would make "scoped out and outside a workspace" representable.
 */
const EvalBaselineAbsenceSchema = Schema.Literals([
  "no-workspace",
  "none-yet",
  "recording-disabled",
  "scoped-out"
]);

type EvalBaselineAbsence = typeof EvalBaselineAbsenceSchema.Type;

/**
 * What the baseline read came back with: the comparison, or the one reason there
 * isn't one. Exactly one of the two is present.
 */
interface EvalBaselineOutcome {
  readonly absence: Option.Option<EvalBaselineAbsence>;
  readonly comparison: Option.Option<EvalComparison>;
  readonly selector: string;
}

const noBaseline = (
  selector: EvalBaselineSelector,
  absence: EvalBaselineAbsence
): EvalBaselineOutcome => ({
  absence: Option.some(absence),
  comparison: Option.none(),
  selector: describeEvalBaselineSelector(selector)
});

/**
 * Why a workspace read came back empty, once it is known that it did. A history
 * that exists and covers other eval files is `scoped-out`; anything else is a
 * workspace that has simply not run these evals yet.
 */
const absenceWithinWorkspace = (input: {
  readonly files: readonly string[];
  readonly history: readonly EvalHistoryEntry[];
}): EvalBaselineAbsence =>
  input.history.length > 0 && comparableEvalRuns(input.history, input.files).length === 0
    ? "scoped-out"
    : "none-yet";

export type { EvalBaselineAbsence, EvalBaselineOutcome, EvalComparison, EvalMetricDelta };
/**
 * The comparison for a finished run, against the workspace's own history.
 *
 * Read before the run is recorded, so a run is never its own baseline, and scoped
 * to the run's own eval files, so a workspace holding two suites does not report
 * one against the other. Nothing here can fail the command: no workspace, no
 * history, a history of nothing but corrupt lines, or an outright read failure all
 * answer "no baseline available", which is the same contract the history write
 * keeps. A comparison is a convenience layered over the run, and a run that spent
 * real model calls must not be reported as failed because a file could not be read.
 *
 * `recordEnabled` is the same `--no-history` the write half is gated on. The read
 * still works with it inside a workspace, comparing against runs already on disk;
 * it only changes which reason a bare directory reports, because someone who
 * turned recording off already knows why nothing was recorded.
 */
export { EvalBaselineAbsenceSchema, EvalComparisonSchema, EvalMetricDeltaSchema };
