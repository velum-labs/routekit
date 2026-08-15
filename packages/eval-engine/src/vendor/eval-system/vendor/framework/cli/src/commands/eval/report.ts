// How `routekit-eval eval` reports itself: what it discovered, and what happened when it
// ran. Split out of `command.ts` so the command file stays about wiring (flags,
// the daemon provider, the child spawn) and this one owns rendering. json mode is
// the agent-facing contract — exactly one envelope on stdout — so both reporters
// return early on it rather than mixing plain lines into the document.
import { Effect, Option } from "effect";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { EvalBaselineOutcome } from "./baseline.ts";
import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";

import {
  CliOutputAlreadyReported,
  renderEnvelope,
} from "../../../../contracts/internal/src/cli/cli-output.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { formatEvalBaseline } from "./comparison-report.ts";
import { EVAL_SUFFIX } from "./discover.ts";
import {
  isCandidateRun,
  isCompletedRun,
  isFailedRun,
  isJudgeRun,
  runErrorText,
  runModel,
  runUsage,
  totalCostUsd,
} from "./results.ts";

const STATUS_LABELS: Readonly<Record<EvalTestRow["status"], string>> = {
  fail: "FAIL",
  pass: "pass",
  skipped: "skip",
};

// Event types worth a word on the run's line when they happened at all. Human
// mode picks; the full per-type census is in `eventCounts` under `--json`, so a
// type missing from this list is still reported, just not inline.
const NOTEWORTHY_EVENT_TYPES: readonly string[] = [
  "compaction.started",
  "retry.scheduled",
  "runtime.error",
  "runtime.warning",
];

// Enough decimals to tell two cheap models apart. A bakeoff run costs a fraction
// of a cent, so the usual two-decimal money format prints every model as $0.00 and
// hides the whole comparison.
const COST_DECIMALS = 6;
const SCORE_DECIMALS = 2;

// What the assertions about a run decided, in the run's own line. `outcome?` is
// printed rather than left out, because a run nobody asserted on is a gap a
// reader should see: silence there would read as "fine".
const OUTCOME_LABELS: Readonly<Record<EvalResultRow["outcome"], string>> = {
  failed: "FAIL",
  passed: "pass",
  unknown: "outcome?",
};

const CANDIDATE_LABEL = "candidates";
const JUDGE_LABEL = "judge";

// Both labels padded to the same width so the two figures sit in one column and
// the size difference between them is readable at a glance, which is the whole
// point of printing them together.
const SPEND_LABEL_WIDTH = CANDIDATE_LABEL.length;

/**
 * One side of the spend split: how many runs, and what they cost together.
 *
 * Absent cost stays absent. A harness that reports no usage prints a run count and
 * no figure, rather than claiming the grading was free.
 *
 * A run that was cut off is counted and then said to be cut off, rather than left
 * out. This line puts a count and a cost next to each other, so a count that
 * quietly included a run contributing no cost would halve the per-run figure a
 * reader works out from the two. Dropping it instead would be worse here than in
 * the history: the per-run lines printed immediately above include the cut-off
 * row, so a count that skipped it would contradict what the reader just read.
 */
const formatSpendLine = (
  label: string,
  rows: readonly EvalResultRow[]
): string => {
  const cost = totalCostUsd(rows);
  const runs = `${rows.length} ${rows.length === 1 ? "run" : "runs"}`;
  const cutOff = rows.filter((row) => !isCompletedRun(row)).length;
  const segments = [
    label.padEnd(SPEND_LABEL_WIDTH),
    runs,
    ...(cutOff === 0 ? [] : [`(${cutOff} cut off)`]),
    ...(cost === undefined ? [] : [`$${cost.toFixed(COST_DECIMALS)}`]),
  ];
  return segments.join("  ");
};

/**
 * The candidate/judge spend split, or nothing at all.
 *
 * Only printed when a judge actually ran. An eval that grades nothing has one kind
 * of run and no split to make, and printing a total under a single line of output
 * would be noise. When a judge did run this is the line that matters: on the
 * bakeoff that prompted it the grader was 98.9% of the spend, so a reader who saw
 * only the run total was reading a fact about the judge.
 */
const spendSplitLines = (
  results: readonly EvalResultRow[]
): readonly string[] => {
  const judge = results.filter(isJudgeRun);
  if (judge.length === 0) {
    return [];
  }
  return [
    formatSpendLine(CANDIDATE_LABEL, results.filter(isCandidateRun)),
    formatSpendLine(JUDGE_LABEL, judge),
  ];
};

/**
 * The spend part of a run's line. Dropped entirely when the harness reported no
 * usage, so a harness that does not report it prints exactly what it did before.
 */
const usageSegments = (row: EvalResultRow): readonly string[] => {
  const usage = runUsage(row);
  if (Option.isNone(usage)) {
    return [];
  }
  const segments: string[] = [];
  const { contextTokens, costUsd } = usage.value;
  if (contextTokens !== undefined) {
    segments.push(`${contextTokens} tok`);
  }
  if (costUsd !== undefined) {
    segments.push(`$${costUsd.toFixed(COST_DECIMALS)}`);
  }
  return segments;
};

/**
 * One line describing what the run did: the model, then only the measurements the
 * row actually carries. An absent field is left out rather than shown as `0`,
 * because a run that reported nothing did not report zero.
 */
const formatRunLine = (row: EvalResultRow): string => {
  // The judge's slug is a model name like any other, and on a bakeoff it appears
  // once per candidate. Without the label the reader has to already know which of
  // the models on screen was the one doing the grading.
  //
  // A judge row leads with that label instead of a verdict because it is not a
  // model under evaluation: nobody asserts on the grader, so every judge row would
  // otherwise read `outcome?` and turn the one column that answers "which model
  // was right" into noise. The row still carries its `outcome` under `--json`.
  const segments: string[] = isJudgeRun(row)
    ? [JUDGE_LABEL, runModel(row)]
    : [OUTCOME_LABELS[row.outcome], runModel(row)];
  if (row.durationMs !== undefined) {
    segments.push(`${Math.round(row.durationMs)}ms`);
  }
  if (row.toolCalls !== undefined) {
    const count = row.toolCalls.length;
    segments.push(`${count} ${count === 1 ? "tool" : "tools"}`);
  }
  if (row.outputChars !== undefined) {
    segments.push(`${row.outputChars} chars`);
  }
  if (row.score !== undefined) {
    segments.push(`score=${row.score.toFixed(SCORE_DECIMALS)}`);
  }
  segments.push(...usageSegments(row));
  for (const type of NOTEWORTHY_EVENT_TYPES) {
    const count = row.eventCounts?.[type] ?? 0;
    if (count > 0) {
      segments.push(`${count} ${type}`);
    }
  }
  if (isFailedRun(row)) {
    segments.push("FAILED");
  }
  // Every measurement above is absent on a cut-off run, so without this the line
  // is a model slug and an `outcome?` and reads like a run that answered and was
  // never checked. It was killed before it answered at all.
  if (!isCompletedRun(row)) {
    segments.push("CUT OFF");
  }
  return segments.join("  ");
};

/**
 * The human-mode body: per-test lines, then per-run lines, then the comparison.
 * Split from {@link reportRunOutcome} so that function stays a mode switch rather
 * than also being the whole human renderer.
 */
const writeHumanOutcome = Effect.fn("EvalCommand.writeHumanOutcome")(
  function* (input: {
    readonly baseline: EvalBaselineOutcome;
    readonly cliIo: CliIo["Service"];
    readonly results: readonly EvalResultRow[];
    readonly tests: readonly EvalTestRow[];
  }) {
    for (const test of input.tests) {
      const duration =
        test.durationMs === undefined
          ? ""
          : ` ${Math.round(test.durationMs)}ms`;
      // Four characters each so the names line up in a column.
      const label = STATUS_LABELS[test.status];
      yield* input.cliIo.writeStdout(`${label}  ${test.name}${duration}\n`);
    }

    for (const row of input.results) {
      yield* input.cliIo.writeStdout(`${formatRunLine(row)}\n`);
      // The failure text goes on its own indented line: it is a whole sentence
      // from the provider, long enough to bury the measurements beside it.
      const error = runErrorText(row);
      if (Option.isSome(error)) {
        yield* input.cliIo.writeStdout(`  ${error.value}\n`);
      }
      // Separate from the runtime error above, and both can show: one is the
      // provider saying the call broke, the other is the eval saying the answer
      // was wrong. A run can finish cleanly and still be wrong.
      if (row.outcomeDetail !== undefined) {
        yield* input.cliIo.writeStdout(`  ${row.outcomeDetail}\n`);
      }
    }

    for (const line of spendSplitLines(input.results)) {
      yield* input.cliIo.writeStdout(`${line}\n`);
    }

    const baselineBlock = formatEvalBaseline(input.baseline);
    if (baselineBlock.length > 0) {
      yield* input.cliIo.writeStdout(baselineBlock);
    }
  }
);

export const reportDiscovery = Effect.fn("EvalCommand.reportDiscovery")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly files: readonly string[];
    readonly mode: "human" | "json";
    readonly run: boolean;
  }) {
    if (input.mode === "json") {
      yield* input.cliIo.writeStdout(
        renderEnvelope("eval", { files: input.files }, true)
      );
      return;
    }
    if (input.files.length === 0) {
      yield* input.cliIo.writeStdout(`No ${EVAL_SUFFIX} files found.\n`);
      return;
    }
    const heading = input.run
      ? "Discovered eval files:"
      : `Discovered ${input.files.length} eval file(s):`;
    yield* input.cliIo.writeStdout(
      `${heading}\n${input.files.map((file) => `  ${file}`).join("\n")}\n`
    );
  }
);

/**
 * Report a finished run. In json mode the whole outcome is one envelope carrying
 * the rows; in human mode it is at most one plain line per row, so an eval that
 * ran no agent prints nothing, followed by the baseline comparison when there was
 * one to make.
 */
export const reportRunOutcome = Effect.fn("EvalCommand.reportRun")(
  function* (input: {
    readonly baseline: EvalBaselineOutcome;
    readonly cliIo: CliIo["Service"];
    readonly exitCode: number;
    readonly files: readonly string[];
    readonly mode: "human" | "json";
    readonly results: readonly EvalResultRow[];
    readonly tests: readonly EvalTestRow[];
  }) {
    if (input.mode === "json") {
      const ok = input.exitCode === 0;
      yield* input.cliIo.writeStdout(
        renderEnvelope(
          "eval",
          {
            // `null` rather than an omitted key: an agent reading the envelope
            // needs to tell "no baseline to compare against" apart from a field
            // this version of the command does not emit.
            comparison: Option.getOrNull(input.baseline.comparison),
            // A sibling key rather than a shape change to `comparison`, which
            // anything already branching on `null` there would break on. Same
            // argument one level down: `null` alone cannot tell "no runs yet" from
            // "no run will ever be recorded here".
            comparisonAbsence: Option.getOrNull(input.baseline.absence),
            exitCode: input.exitCode,
            files: input.files,
            results: input.results,
            tests: input.tests,
          },
          ok
        )
      );
      return yield* ok
        ? Effect.void
        : new CliOutputAlreadyReported({
            cause: `node --test exited with code ${input.exitCode}`,
          });
    }

    yield* writeHumanOutcome(input);

    // The comparison is printed above but never consulted here: a regression is
    // reported, not a failure. The exit code says whether `node --test` passed
    // and nothing else, so wiring an eval into CI does not silently turn normal
    // run-to-run variance into a red build.
    if (input.exitCode !== 0) {
      return yield* new CliFailureError({
        detail: `\`node --test\` exited with code ${input.exitCode}.`,
      });
    }
  }
);
