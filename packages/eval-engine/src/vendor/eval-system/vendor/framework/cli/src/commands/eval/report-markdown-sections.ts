// What the shareable report says about the run that just finished: its
// provenance, its models, its tests, its failures, and what the grading cost. The
// run-to-run blocks live in `report-markdown-history.ts`, the Correctness column
// and its reconciliation live in `report-markdown-correctness.ts`, and the value
// formatting (including the never-render-a-zero rule) lives in
// `report-markdown-format.ts`.
import type { EvalTestRow } from "./junit.ts";
import type { ModelRollup } from "./report-markdown-correctness.ts";
import type { EvalResultRow } from "./results.ts";

import {
  CONTRADICTED,
  contradictionNote,
  formatCorrectness,
  rollUpModels,
  contradictingTestFailures,
} from "./report-markdown-correctness.ts";
import {
  cell,
  fileName,
  formatCost,
  formatDuration,
  table,
  UNMEASURED,
} from "./report-markdown-format.ts";
import {
  isCandidateRun,
  isCompletedRun,
  isJudgeRun,
  runModel,
  totalCostUsd,
} from "./results.ts";

export { runModel };

const STATUS_LABELS: Readonly<Record<EvalTestRow["status"], string>> = {
  fail: "fail",
  pass: "pass",
  skipped: "skipped",
};

/**
 * The count qualified, when any run did not come back.
 *
 * `Agent runs` counts runs, and a run that was started and killed is still a run
 * that was started: it was one row on the channel before this and it is one row on
 * the channel now, so nothing is counted twice. What it is not is a run anybody
 * measured, and the count alone cannot say that, so it says it here.
 */
const cutOffSuffix = (candidates: readonly EvalResultRow[]): string => {
  const cutOff = candidates.filter((row) => !isCompletedRun(row)).length;
  return cutOff === 0 ? "" : ` (${cutOff} cut off before finishing)`;
};

/**
 * A run count for the spend table, where the cost sits in the next cell.
 *
 * Same reasoning as the count in the header, with one extra reason to qualify it
 * rather than leave it bare: a reader divides the cost beside it by this number,
 * and a run that contributed no cost would halve the answer. The count still
 * includes the cut-off run, because the Models table above lists it as a run.
 */
const spendRuns = (rows: readonly EvalResultRow[]): string => {
  const cutOff = rows.filter((row) => !isCompletedRun(row)).length;
  return cutOff === 0
    ? String(rows.length)
    : `${rows.length} (${cutOff} cut off)`;
};

/**
 * The headline: what ran, when, and how it came out.
 *
 * Enough for a reader to trust the rest without being talked through it. The
 * timestamp names when the models were asked, so the document still answers that
 * when it is re-read a month later in a thread with no other context.
 */
export const provenanceSection = (input: {
  readonly files: readonly string[];
  readonly generatedAt: string;
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): readonly string[] => {
  const candidates = input.results.filter(isCandidateRun);
  const models = [...new Set(candidates.map(runModel))];
  const counted = (status: EvalTestRow["status"]): number =>
    input.tests.filter((test) => test.status === status).length;
  const skipped = counted("skipped");
  const outcome =
    input.tests.length === 0
      ? `no per-test outcome was reported (${UNMEASURED})`
      : [
          `${counted("pass")} passed`,
          `${counted("fail")} failed`,
          ...(skipped === 0 ? [] : [`${skipped} skipped`]),
        ].join(", ");
  return [
    "# Eval report",
    "",
    `Run on ${input.generatedAt}.`,
    "",
    `- Evals: ${input.files.length === 0 ? UNMEASURED : input.files.map(fileName).join(", ")}`,
    `- Models compared: ${models.length === 0 ? UNMEASURED : models.join(", ")}`,
    `- Agent runs: ${candidates.length}${cutOffSuffix(candidates)}`,
    `- Tests: ${outcome}`,
  ];
};

/**
 * Which models were asked and never answered, named.
 *
 * The table alone cannot say this. A model whose only run was cut off reads one
 * run, no failures, and `unmeasured` correctness, which is indistinguishable from
 * a model that answered fine and was never asserted on. The difference matters: one
 * of them was never given the chance.
 *
 * Named rather than counted, because in a bakeoff the question is always WHICH
 * model went missing, and the run that motivated this is the shape that loses them
 * silently (ROUTEKIT_EVAL-792).
 */
const cutOffNote = (rollups: readonly ModelRollup[]): readonly string[] => {
  const missing = rollups.filter((rollup) => rollup.cutOffRuns > 0);
  if (missing.length === 0) {
    return [];
  }
  const named = missing
    .map((rollup) => `${cell(rollup.model)} (${rollup.cutOffRuns})`)
    .join(", ");
  return [
    "",
    `Cut off before finishing: ${named}. Those runs were started and then killed before they reported anything, so they have no outcome, no latency, and no cost. None of those is a zero. A model comparison written as \`Promise.all\` over several models inside one \`test()\` does this whenever one candidate's assertion throws: the rejection ends the test and every sibling still in flight dies with it. One \`test()\` per model isolates them.`,
  ];
};

/**
 * The per-model table, which is the part somebody screenshots.
 *
 * Correctness is read off the row's own `outcome` (ROUTEKIT_EVAL-760), so it holds for the
 * bakeoff shape that motivated the column: `Promise.all` over N models inside one
 * `test()` emits N result rows and a single test row, and the row is what says
 * which model was right. A model nobody asserted on still reads {@link UNMEASURED},
 * because an unchecked answer is not a correct one.
 *
 * The tests are passed in for the one thing the rows cannot see: an assertion that
 * never reached RouteKitEval's channel failed the test without failing any run, and the
 * column would otherwise report a clean pass in a document whose own `## Tests`
 * says `fail` (ROUTEKIT_EVAL-911).
 */
export const modelSection = (
  results: readonly EvalResultRow[],
  tests: readonly EvalTestRow[]
): readonly string[] => {
  const rollups = rollUpModels(results);
  if (rollups.length === 0) {
    return ["## Models", "", `No model run was recorded (${UNMEASURED}).`];
  }
  const contradicting = contradictingTestFailures({
    rollups,
    tests,
  });
  return [
    "## Models",
    "",
    ...table(
      ["Model", "Runs", "Failed runs", "Correctness", "Avg latency", "Cost"],
      ["---", "---:", "---:", "---", "---:", "---:"],
      rollups.map((rollup) => [
        cell(rollup.model),
        String(rollup.runs),
        String(rollup.failedRuns),
        formatCorrectness(rollup, contradicting > 0),
        formatDuration(rollup.meanDurationMs),
        formatCost(rollup.costUsd),
      ])
    ),
    "",
    `Correctness counts the runs whose assertions passed. It is a different question from the failures column, which says whether the model answered at all: a model can answer perfectly and still be marked wrong, and it can fail outright without ever being judged. A run nobody asserted on reads \`${UNMEASURED}\` rather than counting either way.`,
    ...contradictionNote(contradicting),
    ...cutOffNote(rollups),
  ];
};

/** Per-test outcomes: the only place a pass or a fail is stated. */
export const testSection = (
  tests: readonly EvalTestRow[]
): readonly string[] => {
  if (tests.length === 0) {
    return [
      "## Tests",
      "",
      `No per-test outcome was reported (${UNMEASURED}).`,
    ];
  }
  return [
    "## Tests",
    "",
    ...table(
      ["Test", "Result", "Duration"],
      ["---", "---", "---:"],
      tests.map((test) => [
        cell(test.name),
        STATUS_LABELS[test.status],
        formatDuration(test.durationMs),
      ])
    ),
  ];
};

/**
 * What the run's own verdicts came to, as one sentence under the spend table.
 *
 * The reasons themselves are quoted once, under Failures, rather than a second
 * time here: they are whole paragraphs, and a document that prints the same
 * paragraph twice invites a reader to hunt for the difference. This says whether
 * there is anything to go and read.
 *
 * The reason is named as the judge's here, and only here. A row records the
 * message of whichever assertion failed it, and a plain `expect` and an LLM judge
 * write to the same field, so the attribution is the section's context rather than
 * anything the row proves: this sentence renders only when a judge actually ran,
 * and grading a run it did not decide is the uncommon shape. Failures itself stays
 * neutral ("was judged failed") because that section renders with no judge at all,
 * so the stronger claim is confined to the one place the document can support it.
 */
const verdictLine = (candidates: readonly EvalResultRow[]): string => {
  const rejected = candidates.filter((row) => row.outcome === "failed");
  const quoted = rejected.filter(
    (row) => (row.outcomeDetail?.trim().length ?? 0) > 0
  );
  if (rejected.length === 0) {
    return candidates.some((row) => row.outcome === "passed")
      ? "Judge verdicts: every graded run was accepted, so there is no rejection to quote."
      : `Judge verdicts: ${UNMEASURED}. Grading happened and cost what it cost, but no run came back with a recorded verdict.`;
  }
  if (quoted.length === 0) {
    return `Judge verdicts: ${UNMEASURED}. ${rejected.length} run${rejected.length === 1 ? " was" : "s were"} rejected, but none recorded a written reason, so none is quoted here.`;
  }
  return quoted.length === rejected.length
    ? "Judge verdicts: the judge's reason for every rejected run is quoted under Failures above."
    : `Judge verdicts: ${quoted.length} of the ${rejected.length} rejected runs recorded the judge's reason, quoted under Failures above. The rest recorded none (${UNMEASURED}).`;
};

/**
 * What the grading cost, and what its verdicts came to.
 *
 * The split is the honest half: on the bakeoff that prompted this work the judge
 * was 98.9% of the spend, so a reader shown a single total is reading a fact about
 * the grader rather than about the models being compared.
 *
 * This section used to name every verdict unrecorded, on the grounds that Bun's
 * JUnit reporter emits a bare `<failure />` with no message. That is still true of
 * JUnit and it was never the route the reason takes: the SDK writes the failing
 * assertion's message onto the results channel as its own line, `joinOutcomes`
 * folds it onto the row as `outcomeDetail`, and the row is what this report
 * renders from. The text was on the row the whole time and the document was the
 * one surface not reading it (ROUTEKIT_EVAL-794).
 */
export const judgeSection = (
  results: readonly EvalResultRow[]
): readonly string[] => {
  const judge = results.filter(isJudgeRun);
  if (judge.length === 0) {
    return [];
  }
  const candidates = results.filter(isCandidateRun);
  return [
    "## Judging",
    "",
    ...table(
      ["Spend", "Runs", "Cost"],
      ["---", "---:", "---:"],
      [
        [
          "Models under test",
          spendRuns(candidates),
          formatCost(totalCostUsd(candidates)),
        ],
        ["Judge", spendRuns(judge), formatCost(totalCostUsd(judge))],
      ]
    ),
    "",
    verdictLine(candidates),
  ];
};

/**
 * The report's own glossary.
 *
 * `contradicted` is defined only on the runs that use it. A glossary is read by
 * somebody who just met a word in the document above, so a definition for a word
 * that never appears sends them back up the page looking for it. `unmeasured` is
 * unconditional because it renders somewhere in nearly every report.
 */
export const footerSection = (input: {
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): readonly string[] => {
  const contradicted =
    contradictingTestFailures({
      rollups: rollUpModels(input.results),
      tests: input.tests,
    }) > 0;
  return [
    "## Reading this report",
    "",
    `- \`${UNMEASURED}\` means the harness reported no value for that figure. It does not mean zero, and it does not mean the run failed.`,
    ...(contradicted
      ? [
          `- \`${CONTRADICTED}\` beside a correctness figure means the runs passed the assertions RouteKitEval graded, and a test in this run failed anyway. The figure is measured, and it is not the last word: read \`## Tests\`.`,
        ]
      : []),
    "- Cost is what the provider reported for the run, in US dollars.",
    "- This report is the evidence, not a recommendation. It does not pick a winner.",
  ];
};
