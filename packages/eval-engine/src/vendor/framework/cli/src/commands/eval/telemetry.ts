import { Schema } from "effect";

import type { EvalTestRow } from "./junit.ts";
import type { EvalResultRow } from "./results.ts";
import type { TelemetryProps } from "../../telemetry/telemetry-event.ts";

import {
  isCandidateRun,
  isFailedRun,
} from "./results.ts";

const SCORE_SCALE = 1000;
const EvalTelemetryOutcomeSchema = Schema.Literals([
  "passed",
  "quality_failure",
  "judge_failure",
  "infrastructure_failure",
]);

export type EvalTelemetryOutcome = typeof EvalTelemetryOutcomeSchema.Type;

export const classifyEvalTelemetryOutcome = (input: {
  readonly exitCode: number;
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): EvalTelemetryOutcome => {
  const candidates = input.results.filter(isCandidateRun);
  if (
    candidates.some((row) => row.cutOff || isFailedRun(row)) ||
    (input.exitCode !== 0 && candidates.length === 0)
  ) {
    return "infrastructure_failure";
  }
  if (candidates.some((row) => row.outcome === "failed")) {
    return "quality_failure";
  }
  if (
    input.tests.some((test) => test.status === "fail") &&
    candidates.some((row) => row.outcome === "unknown")
  ) {
    return "judge_failure";
  }
  return input.exitCode === 0 ? "passed" : "infrastructure_failure";
};

const singleModel = (models: readonly string[]): string | undefined => {
  const distinctModels = new Set(models);
  return distinctModels.size === 1 ? models[0] : undefined;
};

export const makeEvalTelemetryProps = (input: {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly results: readonly EvalResultRow[];
  readonly tests: readonly EvalTestRow[];
}): TelemetryProps => {
  const candidates = input.results.filter(isCandidateRun);
  const judges = input.results.filter((row) => !isCandidateRun(row));
  const scores = candidates
    .map((row) => row.score)
    .filter(
      (score): score is number => score !== undefined && Number.isFinite(score)
    );
  const models = candidates
    .map((row) => row.terminal?.model ?? row.model)
    .filter((model) => model !== "unknown");
  const judgeModels = judges
    .map((row) => row.terminal?.model ?? row.model)
    .filter((model) => model !== "unknown");
  const meanScore =
    scores.length === 0
      ? undefined
      : scores.reduce((total, score) => total + score, 0) / scores.length;
  const meanScoreMilli =
    meanScore === undefined
      ? undefined
      : Math.round(Math.min(1, Math.max(0, meanScore)) * SCORE_SCALE);
  const model = singleModel(models);
  const judgeModel = singleModel(judgeModels);
  return {
    duration_ms: input.durationMs,
    outcome: classifyEvalTelemetryOutcome(input),
    ...(meanScoreMilli === undefined
      ? {}
      : { mean_score_milli: meanScoreMilli }),
    ...(judgeModel === undefined ? {} : { judge_model: judgeModel }),
    ...(model === undefined ? {} : { model }),
    tests_failed: input.tests.filter((test) => test.status === "fail").length,
    tests_passed: input.tests.filter((test) => test.status === "pass").length,
    tests_skipped: input.tests.filter((test) => test.status === "skipped")
      .length,
  };
};
