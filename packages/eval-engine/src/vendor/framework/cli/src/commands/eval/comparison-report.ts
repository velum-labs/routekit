// Rendering the baseline comparison for a human. Split out of `report.ts` so that
// file keeps its one job (what the run itself printed) rather than growing a
// second as the comparison gains lines. `baseline.ts` decides what is worse; this
// only decides how it reads.
import { Option } from "effect";

import type {
  EvalBaselineAbsence,
  EvalBaselineOutcome,
  EvalComparison,
  EvalMetricDelta,
} from "./baseline.ts";

/** Label column width, so the metric lines read as a column rather than a list. */
const METRIC_LABEL_WIDTH = 12;

const PERCENT_SCALE = 100;

const PERCENT_DECIMALS = 1;

// Enough decimals to tell two cheap models apart, matching the per-run line: a
// bakeoff costs a fraction of a cent, and two decimals prints every model as
// $0.00.
const COST_DECIMALS = 6;

const formatPercent = (rate: number): string =>
  `${(rate * PERCENT_SCALE).toFixed(PERCENT_DECIMALS)}%`;

const formatCost = (cost: number): string => `$${cost.toFixed(COST_DECIMALS)}`;

const formatMove = (
  delta: EvalMetricDelta,
  format: (value: number) => string
): string => `${format(delta.baseline)} -> ${format(delta.current)}`;

const metricLine = (input: {
  readonly delta: EvalMetricDelta;
  readonly format: (value: number) => string;
  readonly label: string;
  readonly regressed: boolean;
}): string => {
  const marker = input.regressed ? "  REGRESSED" : "";
  return `  ${input.label.padEnd(METRIC_LABEL_WIDTH)}${formatMove(input.delta, input.format)}${marker}\n`;
};

const headingFor = (comparison: EvalComparison): string => {
  const where = `the run at ${comparison.baselineRecordedAt} (--baseline ${comparison.selector})`;
  return comparison.regressions.length > 0
    ? `REGRESSION vs ${where}`
    : `Compared with ${where}`;
};

/**
 * The run-level metrics.
 *
 * Only metrics that exist on both sides are printed at all, so a harness that
 * reported no cost prints no cost line rather than one claiming spend moved to or
 * from zero. Cost is never marked: spending more to answer better is a trade
 * someone chose, and flagging it would train people to skip the whole block.
 */
const runMetricLines = (comparison: EvalComparison): readonly string[] => {
  const lines: string[] = [];
  if (comparison.passRate !== undefined) {
    lines.push(
      metricLine({
        delta: comparison.passRate,
        format: formatPercent,
        label: "pass rate",
        regressed: comparison.regressions.includes("pass-rate"),
      })
    );
  }
  if (comparison.failedRunRate !== undefined) {
    lines.push(
      metricLine({
        delta: comparison.failedRunRate,
        format: formatPercent,
        label: "failed runs",
        regressed: comparison.regressions.includes("failed-run-rate"),
      })
    );
  }
  if (comparison.costUsd !== undefined) {
    lines.push(
      metricLine({
        delta: comparison.costUsd,
        format: formatCost,
        label: "cost",
        regressed: false,
      })
    );
  }
  return lines;
};

/** One line per model both runs exercised, skipping any that measured nothing. */
const modelLines = (comparison: EvalComparison): readonly string[] =>
  comparison.models.flatMap((model) => {
    const segments: string[] = [];
    if (model.failedRunRate !== undefined) {
      segments.push(
        `failed runs ${formatMove(model.failedRunRate, formatPercent)}`
      );
    }
    if (model.costUsd !== undefined) {
      segments.push(`cost ${formatMove(model.costUsd, formatCost)}`);
    }
    return segments.length === 0
      ? []
      : [`  ${model.model}  ${segments.join("  ")}\n`];
  });

/**
 * Models only one of the runs exercised.
 *
 * Printed so a partial comparison announces itself instead of quietly reading as
 * a full one. Never a regression: a model that did not run did not score zero.
 */
const notMeasuredLines = (comparison: EvalComparison): readonly string[] => {
  const lines: string[] = [];
  if (comparison.notMeasuredInCurrent.length > 0) {
    lines.push(
      `  not measured in this run: ${comparison.notMeasuredInCurrent.join(", ")}\n`
    );
  }
  if (comparison.notMeasuredInBaseline.length > 0) {
    lines.push(
      `  not measured in the baseline: ${comparison.notMeasuredInBaseline.join(", ")}\n`
    );
  }
  return lines;
};

export const formatEvalComparison = (comparison: EvalComparison): string =>
  [
    `\n${headingFor(comparison)}\n`,
    ...runMetricLines(comparison),
    ...modelLines(comparison),
    ...notMeasuredLines(comparison),
  ].join("");

/**
 * The one line that says why there is no comparison, per reason.
 *
 * Silence is right for exactly two of the four. A workspace with no earlier runs
 * compares on the next run without anyone doing anything, and saying so would put
 * a line on the most common first run there is. `--no-history` is someone asking
 * for this, and answering them with the reason they already gave is nagging.
 *
 * The other two are told, because neither fixes itself by running the eval again.
 * A total record rather than a switch: a reason added later cannot compile until
 * it has decided which of the two it is.
 */
const ABSENCE_LINES: Record<EvalBaselineAbsence, (selector: string) => string> =
  {
    "no-workspace": (selector) =>
      `\nNo baseline (--baseline ${selector}). A run history is only kept inside an Ori workspace, so this run was not recorded and there is nothing here to compare against; run "ori init" to start one.\n`,
    "none-yet": () => "",
    "recording-disabled": () => "",
    "scoped-out": (selector) =>
      `\nNo comparable earlier run (--baseline ${selector}). A baseline has to have covered the same eval files as this run.\n`,
  };

/** The comparison block, or the one line that says why there isn't one. */
export const formatEvalBaseline = (outcome: EvalBaselineOutcome): string =>
  Option.isSome(outcome.comparison)
    ? formatEvalComparison(outcome.comparison.value)
    : Option.match(outcome.absence, {
        onNone: () => "",
        onSome: (absence) => ABSENCE_LINES[absence](outcome.selector),
      });
