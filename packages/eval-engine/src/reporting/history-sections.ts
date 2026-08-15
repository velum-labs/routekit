// The two blocks that put this run next to other runs: the baseline comparison,
// and the series of earlier runs. Split from `report-markdown-sections.ts` because
// those describe the run that just happened while these describe its relationship
// to runs that happened before, which is the same seam `comparison-report.ts` and
// `report.ts` already sit on either side of.
//
// Both hold one line. A model, or a metric, that only one of two runs measured is
// named as not measured and never counted as a move to or from zero.
import { Option } from "effect";

import type { EvalComparison } from "../baseline/compare.js";
import type { EvalHistoryEntry } from "../history/index.js";

import { formatCost, formatPercent, table, UNMEASURED } from "./format.js";

/** How many earlier runs the trend table shows, oldest first. */
const TREND_RUNS = 10;

/**
 * The metric rows, and only the metrics both runs actually measured.
 *
 * A metric absent on either side is dropped rather than defaulted, so a harness
 * that went quiet between two runs never reads as spend or a pass rate moving to
 * zero. Cost is reported and never marked: spending more to answer better is a
 * trade somebody chose, and flagging it would train people to skip the block.
 */
const comparisonRows = (value: EvalComparison): readonly (readonly string[])[] => {
  const rows: (readonly string[])[] = [];
  if (value.passRate !== undefined) {
    rows.push([
      "Pass rate",
      formatPercent(value.passRate.baseline),
      formatPercent(value.passRate.current),
      value.regressions.includes("pass-rate") ? "regressed" : ""
    ]);
  }
  if (value.failedRunRate !== undefined) {
    rows.push([
      "Failed runs",
      formatPercent(value.failedRunRate.baseline),
      formatPercent(value.failedRunRate.current),
      value.regressions.includes("failed-run-rate") ? "regressed" : ""
    ]);
  }
  if (value.costUsd !== undefined) {
    rows.push(["Cost", formatCost(value.costUsd.baseline), formatCost(value.costUsd.current), ""]);
  }
  return rows;
};

/**
 * Models only one of the two runs exercised.
 *
 * Named so a partial comparison announces itself instead of quietly reading as a
 * complete one, and never counted as a regression: a model that did not run did
 * not score zero. The trailing sentence spells that out, because this document is
 * read by somebody who cannot ask what the list means.
 */
const notMeasuredLines = (value: EvalComparison): readonly string[] => {
  const lines = [
    ...(value.notMeasuredInCurrent.length === 0
      ? []
      : [`- Not measured in this run: ${value.notMeasuredInCurrent.join(", ")}`]),
    ...(value.notMeasuredInBaseline.length === 0
      ? []
      : [`- Not measured in the earlier run: ${value.notMeasuredInBaseline.join(", ")}`])
  ];
  return lines.length === 0
    ? []
    : [
        "",
        ...lines,
        "",
        "A model on either list ran in only one of the two runs, so there is nothing to hold it against. That is not the same as it scoring nothing."
      ];
};

/**
 * The baseline block, present only when there was an earlier run worth comparing
 * to. A first run in a fresh workspace has no baseline, which is a normal outcome
 * rather than an error or an empty heading.
 */
export const comparisonSection = (comparison: Option.Option<EvalComparison>): readonly string[] => {
  if (Option.isNone(comparison)) {
    return [];
  }
  const { value } = comparison;
  const rows = comparisonRows(value);
  return [
    "## Compared with an earlier run",
    "",
    `Held against the run recorded at ${value.baselineRecordedAt}.`,
    "",
    ...(rows.length === 0
      ? [`No metric was measured in both runs (${UNMEASURED}).`]
      : table(
          // A named fourth column rather than a blank one: an unlabelled header
          // reads as a broken table once this is pasted into Slack or Notion.
          ["Metric", "Earlier", "This run", "Note"],
          ["---", "---:", "---:", "---"],
          rows
        )),
    ...notMeasuredLines(value)
  ];
};

/** Share of measured tests that passed, absent when nothing was measured. */
const entryPassRate = (entry: EvalHistoryEntry): number | undefined => {
  const measured = entry.tests.passed + entry.tests.failed;
  return measured === 0 ? undefined : entry.tests.passed / measured;
};

/**
 * The series, for the reader being shown a number holding steady rather than a
 * single comparison. Trimmed to the most recent {@link TREND_RUNS} so the document
 * stays pasteable.
 *
 * Titled "Run history" rather than "earlier runs" because the run this report
 * describes has already been recorded by the time the file is written, so it is
 * the last row of the table. Calling the section "earlier" would make the newest
 * row a quiet lie.
 */
export const trendSection = (history: readonly EvalHistoryEntry[]): readonly string[] => {
  const recent = history.slice(-TREND_RUNS);
  if (recent.length === 0) {
    return [];
  }
  return [
    "## Run history",
    "",
    ...table(
      ["Recorded", "Pass rate", "Tests passed", "Cost"],
      ["---", "---:", "---:", "---:"],
      recent.map((entry) => [
        entry.recordedAt,
        formatPercent(entryPassRate(entry)),
        `${entry.tests.passed}/${entry.tests.passed + entry.tests.failed}`,
        formatCost(entry.costUsd)
      ])
    )
  ];
};
