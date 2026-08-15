// The Correctness column, and the one thing it cannot see. Split out of
// `report-markdown-sections.ts` so that file stays inside its line budget, and
// kept together here because the column's rule and the qualifier that rescues it
// are the same idea read twice.
//
// THE RULE: the column reads each run's own `outcome`, and only RouteKitEval's matchers
// and the LLM judge ever write one. A plain `expect()` in the same `test()`
// writes nothing, so a run can be graded `passed` on this channel while the test
// that contained it failed — and the report holds both halves. Printing the
// flattering half alone is the defect this module exists to prevent (ROUTEKIT_EVAL-911).
//
// What it deliberately does NOT do is attribute the failure. There is no
// test-to-run join: a result row carries no test name, a test row carries no
// model, and node --test does not hand the SDK its enclosing test (ROUTEKIT_EVAL-760). Matching a
// model slug inside a test name would look like a fix and would be a guess, so
// the document says the failure is unattributed rather than pinning it on
// whichever model was named nearby.
import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";

import { UNMEASURED } from "./report-markdown-format.ts";
import {
  isCandidateRun,
  isCompletedRun,
  isFailedRun,
  runModel,
  totalCostUsd,
} from "./results.ts";

/**
 * How a correctness figure reads when the document disagrees with itself.
 *
 * A separate word from {@link UNMEASURED} because it is a separate state, and
 * conflating them would cost the reader the meaning of both. `unmeasured` says the
 * harness reported no value. This says the harness reported a value and something
 * else in the same document reported the opposite: the figure was measured, it is
 * just not the whole story.
 */
export const CONTRADICTED = "contradicted";

/**
 * The mean of the durations that exist, or `undefined` when none do.
 *
 * Runs that reported no duration are left out of both the sum and the divisor
 * rather than counted as instant, so the average covers only what was timed.
 */
const meanDurationMs = (rows: readonly EvalResultRow[]): number | undefined => {
  const timed = rows.flatMap((row) =>
    row.durationMs === undefined ? [] : [row.durationMs]
  );
  return timed.length === 0
    ? undefined
    : timed.reduce((total, duration) => total + duration, 0) / timed.length;
};

export interface ModelRollup {
  readonly costUsd: number | undefined;
  readonly cutOffRuns: number;
  readonly failedRuns: number;
  readonly meanDurationMs: number | undefined;
  readonly model: string;
  readonly passedRuns: number;
  readonly rejectedRuns: number;
  readonly runs: number;
  readonly unmeasuredRuns: number;
}

/**
 * Roll the candidate runs up per model, in the order the models first answered.
 *
 * Insertion order rather than sorted by any measurement: sorting by cost or speed
 * ranks the models, and ranking is the one thing this report does not do (ROUTEKIT_EVAL-780
 * owns picking a winner). The reader draws their own conclusion from the numbers.
 */
export const rollUpModels = (
  results: readonly EvalResultRow[]
): readonly ModelRollup[] => {
  const byModel = new Map<string, EvalResultRow[]>();
  for (const row of results.filter(isCandidateRun)) {
    const model = runModel(row);
    byModel.set(model, [...(byModel.get(model) ?? []), row]);
  }
  return [...byModel].map(([model, rows]) => ({
    costUsd: totalCostUsd(rows),
    cutOffRuns: rows.filter((row) => !isCompletedRun(row)).length,
    failedRuns: rows.filter(isFailedRun).length,
    meanDurationMs: meanDurationMs(rows),
    model,
    passedRuns: rows.filter((row) => row.outcome === "passed").length,
    rejectedRuns: rows.filter((row) => row.outcome === "failed").length,
    runs: rows.length,
    unmeasuredRuns: rows.filter((row) => row.outcome === "unknown").length,
  }));
};

/**
 * How many test failures contradict a correctness figure this table actually
 * prints.
 *
 * Zero whenever a run was graded failed, because then the outcomes already account
 * for the failures and the table says so in its own cells. Adding a qualifier there
 * would be noise on the common case where RouteKitEval's assertions did the asserting.
 *
 * Zero again when nothing was graded at all, and that case is easy to get wrong.
 * An eval that asserts only with a plain `expect()` leaves every run `unknown`, so
 * every figure reads {@link UNMEASURED} and {@link formatCorrectness} has nothing
 * to qualify — but tests still failed, so a count keyed on the failures alone would
 * print a note about marked figures, and a glossary entry defining the mark, with
 * no mark anywhere in the document. A report that explains a word it never uses
 * sends the reader back up the page hunting for it.
 *
 * Non-zero only in the shape that produces the lie: something was graded, it was
 * graded a pass, and `## Tests` disagrees.
 */
export const contradictingTestFailures = (input: {
  readonly rollups: readonly ModelRollup[];
  readonly tests: readonly EvalTestRow[];
}): number => {
  const graded = input.rollups.some(
    (rollup) => rollup.passedRuns + rollup.rejectedRuns > 0
  );
  const accounted = input.rollups.some((rollup) => rollup.rejectedRuns > 0);
  return graded && !accounted
    ? input.tests.filter((test) => test.status === "fail").length
    : 0;
};

/**
 * How the model's answers came out: `2/3 passed`, plus whatever qualifies it.
 *
 * Every run unasserted reads {@link UNMEASURED} rather than `0/0 passed`, because
 * a model nobody checked has not been shown to be wrong. The unmeasured tail is
 * stated beside the ratio instead of being folded into the denominator, so a run
 * the eval never judged cannot quietly depress a model's score.
 *
 * `contradicted` is the other direction and the reason this takes a second
 * argument: a ratio that counts only RouteKitEval's own assertions can read as a clean pass
 * in a document that reports the test as failed, and a bare `1/1 passed` is a claim
 * this report cannot support once it knows that.
 */
export const formatCorrectness = (
  rollup: ModelRollup,
  contradicted: boolean
): string => {
  const judged = rollup.passedRuns + rollup.rejectedRuns;
  if (judged === 0) {
    return UNMEASURED;
  }
  const qualifiers = [
    ...(contradicted ? [CONTRADICTED] : []),
    ...(rollup.unmeasuredRuns === 0
      ? []
      : [`${rollup.unmeasuredRuns} ${UNMEASURED}`]),
  ];
  const ratio = `${rollup.passedRuns}/${judged} passed`;
  return qualifiers.length === 0
    ? ratio
    : `${ratio} (${qualifiers.join(", ")})`;
};

/**
 * Why the figures above are marked, said once under the table.
 *
 * Once rather than per cell: the reason is a property of the run, not of any one
 * model, and repeating it beside every row would imply the report knows which row
 * it belongs to. It does not, and saying so is the point.
 */
export const contradictionNote = (
  contradictingFailures: number
): readonly string[] => {
  if (contradictingFailures === 0) {
    return [];
  }
  const plural = contradictingFailures === 1 ? "" : "s";
  return [
    "",
    `Marked \`${CONTRADICTED}\`: ${contradictingFailures} test${plural} failed and no run recorded a failing assertion, so the failure cannot be attributed to a model. Correctness counts the assertions RouteKitEval graded, and a plain \`expect()\` inside a test is not one of them: it fails the test without ever reaching the run. The figures above are what RouteKitEval measured; \`## Tests\` below is what the test file decided, and here they disagree. Assert through RouteKitEval's matchers to have a failure land on the model that caused it.`,
  ];
};
