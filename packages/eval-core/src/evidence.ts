import { createHash } from "node:crypto";

import type {
  CompiledRoutingPolicy,
  EvalComparisonResult,
  ModelEvidence,
  RoutingEligibility,
  RoutingObjective,
  RoutingProfile,
  RoutingRejection
} from "@velum-labs/routekit-eval-contracts";
import {
  assertRoutingProfile,
  EvalComparisonResult as EvalComparisonResultSchema,
  ROUTING_SNAPSHOT_VERSION,
  RoutingProfile as RoutingProfileSchema
} from "@velum-labs/routekit-eval-contracts";
import { Data, Schema } from "effect";

export class EvalEvidenceError extends Data.TaggedError("EvalEvidenceError")<{
  readonly message: string;
}> {}

export class EvalPolicyCompilationError extends Data.TaggedError("EvalPolicyCompilationError")<{
  readonly message: string;
  readonly rejected: readonly RoutingRejection[];
}> {}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function aggregateModelEvidence(comparison: EvalComparisonResult): readonly ModelEvidence[] {
  return comparison.models.map(({ model, cases }) => {
    const passedCount = cases.filter((entry) => entry.outcome === "passed").length;
    const failedCount = cases.filter((entry) => entry.outcome === "failed").length;
    const unknownCount = cases.filter((entry) => entry.outcome === "unknown").length;
    const cutoffCount = cases.filter((entry) => entry.outcome === "cutoff").length;
    const sampleCount = cases.length;
    const measuredOutcomes = passedCount + failedCount;
    const scores = cases.flatMap((entry) =>
      entry.measurement.judgeScore === undefined ? [] : [entry.measurement.judgeScore]
    );
    const costs = cases.flatMap((entry) =>
      entry.measurement.costUsd === undefined ? [] : [entry.measurement.costUsd]
    );
    const durations = cases.flatMap((entry) =>
      entry.measurement.durationMs === undefined ? [] : [entry.measurement.durationMs]
    );
    return {
      model,
      sampleCount,
      passedCount,
      failedCount,
      unknownCount,
      cutoffCount,
      ...(measuredOutcomes > 0 ? { passRate: passedCount / measuredOutcomes } : {}),
      ...(sampleCount > 0 ? { failureRate: (failedCount + cutoffCount) / sampleCount } : {}),
      ...(average(scores) === undefined ? {} : { averageJudgeScore: average(scores) }),
      ...(average(costs) === undefined ? {} : { averageCostUsd: average(costs) }),
      ...(percentile95(durations) === undefined ? {} : { p95DurationMs: percentile95(durations) })
    };
  });
}

function rejectionReasons(
  evidence: ModelEvidence,
  eligibility: RoutingEligibility
): readonly string[] {
  const reasons: string[] = [];
  if (evidence.sampleCount === 0) reasons.push("no evaluation cases were measured");
  if (evidence.unknownCount > 0) reasons.push(`${evidence.unknownCount} outcomes are unknown`);
  if (evidence.cutoffCount > 0) reasons.push(`${evidence.cutoffCount} runs were cut off`);
  if (eligibility.minimumPassRate !== undefined) {
    if (evidence.passRate === undefined) reasons.push("pass rate is unmeasured");
    else if (evidence.passRate < eligibility.minimumPassRate) {
      reasons.push(`pass rate ${evidence.passRate} is below ${eligibility.minimumPassRate}`);
    }
  }
  if (eligibility.minimumJudgeScore !== undefined) {
    if (evidence.averageJudgeScore === undefined) reasons.push("judge score is unmeasured");
    else if (evidence.averageJudgeScore < eligibility.minimumJudgeScore) {
      reasons.push(
        `judge score ${evidence.averageJudgeScore} is below ${eligibility.minimumJudgeScore}`
      );
    }
  }
  if (eligibility.maximumFailureRate !== undefined) {
    if (evidence.failureRate === undefined) reasons.push("failure rate is unmeasured");
    else if (evidence.failureRate > eligibility.maximumFailureRate) {
      reasons.push(
        `failure rate ${evidence.failureRate} exceeds ${eligibility.maximumFailureRate}`
      );
    }
  }
  if (eligibility.maximumAverageCostUsd !== undefined) {
    if (evidence.averageCostUsd === undefined) reasons.push("cost is unmeasured");
    else if (evidence.averageCostUsd > eligibility.maximumAverageCostUsd) {
      reasons.push(
        `average cost ${evidence.averageCostUsd} exceeds ${eligibility.maximumAverageCostUsd}`
      );
    }
  }
  if (eligibility.maximumP95DurationMs !== undefined) {
    if (evidence.p95DurationMs === undefined) reasons.push("duration is unmeasured");
    else if (evidence.p95DurationMs > eligibility.maximumP95DurationMs) {
      reasons.push(
        `p95 duration ${evidence.p95DurationMs} exceeds ${eligibility.maximumP95DurationMs}`
      );
    }
  }
  return reasons;
}

function objectiveValue(evidence: ModelEvidence, objective: RoutingObjective): number | undefined {
  switch (objective) {
    case "lowest-cost":
      return evidence.averageCostUsd;
    case "lowest-latency":
      return evidence.p95DurationMs;
    case "highest-quality":
      return evidence.averageJudgeScore ?? evidence.passRate;
  }
}

function compareEvidence(
  left: ModelEvidence,
  right: ModelEvidence,
  objective: RoutingObjective
): number {
  const leftValue = objectiveValue(left, objective);
  const rightValue = objectiveValue(right, objective);
  if (leftValue === undefined && rightValue !== undefined) return 1;
  if (leftValue !== undefined && rightValue === undefined) return -1;
  if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
    return objective === "highest-quality" ? rightValue - leftValue : leftValue - rightValue;
  }
  if (left.passRate !== right.passRate) {
    return (
      (right.passRate ?? Number.NEGATIVE_INFINITY) - (left.passRate ?? Number.NEGATIVE_INFINITY)
    );
  }
  if (left.averageCostUsd !== right.averageCostUsd) {
    return (
      (left.averageCostUsd ?? Number.POSITIVE_INFINITY) -
      (right.averageCostUsd ?? Number.POSITIVE_INFINITY)
    );
  }
  if (left.p95DurationMs !== right.p95DurationMs) {
    return (
      (left.p95DurationMs ?? Number.POSITIVE_INFINITY) -
      (right.p95DurationMs ?? Number.POSITIVE_INFINITY)
    );
  }
  return left.model.localeCompare(right.model);
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function compileRoutingPolicy(
  profile: RoutingProfile,
  comparison: EvalComparisonResult
): CompiledRoutingPolicy {
  try {
    profile = Schema.decodeSync(RoutingProfileSchema)(profile);
    comparison = Schema.decodeSync(EvalComparisonResultSchema)(comparison);
    assertRoutingProfile(profile);
  } catch (cause) {
    throw new EvalEvidenceError({
      message: `routing evidence is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    });
  }
  if (profile.id !== comparison.profileId) {
    throw new EvalEvidenceError({
      message: `comparison profile ${JSON.stringify(comparison.profileId)} does not match ${JSON.stringify(profile.id)}`
    });
  }
  const evidence = aggregateModelEvidence(comparison);
  const evidenceByModel = new Map(evidence.map((entry) => [entry.model, entry]));
  const rejected: RoutingRejection[] = [];
  const eligible: ModelEvidence[] = [];
  for (const model of profile.candidates) {
    const entry = evidenceByModel.get(model);
    if (entry === undefined) {
      rejected.push({ model, reasons: ["model is missing from comparison evidence"] });
      continue;
    }
    const reasons = rejectionReasons(entry, profile.eligibility);
    if (reasons.length > 0) rejected.push({ model, reasons });
    else eligible.push(entry);
  }
  if (eligible.length === 0) {
    throw new EvalPolicyCompilationError({
      message: `routing profile ${JSON.stringify(profile.id)} has no eligible models`,
      rejected
    });
  }
  const ranked = eligible.sort((left, right) => compareEvidence(left, right, profile.objective));
  const [winner, ...fallbacks] = ranked;
  if (winner === undefined) {
    throw new EvalPolicyCompilationError({
      message: `routing profile ${JSON.stringify(profile.id)} has no winner`,
      rejected
    });
  }
  const description = profile.description?.trim();
  return {
    version: ROUTING_SNAPSHOT_VERSION,
    profileId: profile.id,
    selectedModel: winner.model,
    fallbackModels: fallbacks.map((entry) => entry.model),
    objective: profile.objective,
    suiteDigest: comparison.suiteDigest,
    evidenceDigest: stableDigest(evidence),
    evidence,
    rejected,
    ...(description !== undefined && description.length > 0 ? { description } : {})
  };
}
