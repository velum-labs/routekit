import {
  assertExplicitEvalModel,
  assertPublishedRoutingSnapshotV2,
  assertRequestAreaDecomposition,
  COMPOSITIONAL_ROUTING_VERSION,
  type EvalComparisonResult,
  EvalComparisonResult as EvalComparisonResultSchema,
  type PublishedRoutingSnapshotV2,
  type RequestAreaDecomposition,
  type RequestRoutingRequirements,
  ROUTING_AREA_VECTOR_TOLERANCE,
  type RoutingAreaCatalog,
  type RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import {
  type RoutingModelAvailability,
  type RoutingScoreConstraints,
  scoreRoutingCandidates
} from "@velum-labs/routekit-eval-core";
import { Schema } from "effect";

export const MIXED_AREA_QUALIFICATION_SCHEMA_VERSION = 1 as const;

export type MixedAreaQualificationThresholds = Readonly<{
  /** Ignore model pairs whose matrix prediction is effectively tied. */
  minimumPredictedQualityGap: number;
  /** Ignore model pairs whose observed judge averages are effectively tied. */
  minimumObservedJudgeScoreGap: number;
  minimumComparablePairsPerCase: number;
  minimumPairwiseAgreement: number;
}>;

export type MixedAreaBenchmarkCase = Readonly<{
  id: string;
  suiteDigest: string;
  judgeModel: string;
  expectedCaseIds: readonly string[];
  decomposition: RequestAreaDecomposition;
  requirements: RequestRoutingRequirements;
  objective: RoutingObjectivePolicy;
  availableModels: readonly RoutingModelAvailability[];
  constraints?: RoutingScoreConstraints;
}>;

export type MixedAreaBenchmark = Readonly<{
  definitionSetDigest: string;
  evidenceDigest: string;
  candidateModels: readonly string[];
  cases: readonly MixedAreaBenchmarkCase[];
  scoring: MixedAreaQualificationThresholds;
}>;

export type MixedAreaQualificationObservation =
  | Readonly<{
      caseId: string;
      comparison: unknown;
    }>
  | Readonly<{
      caseId: string;
      failure: "comparison_call_failed";
    }>;

export type MixedAreaQualificationFailureCode =
  | "duplicate_observation"
  | "missing_observation"
  | "comparison_call_failed"
  | "invalid_comparison"
  | "profile_mismatch"
  | "suite_digest_mismatch"
  | "judge_mismatch"
  | "unexpected_candidate"
  | "duplicate_candidate"
  | "missing_candidate"
  | "incomplete_cases"
  | "duplicate_case"
  | "missing_case"
  | "unknown_case"
  | "nonterminal_case"
  | "missing_judge_score"
  | "scoring_failed"
  | "insufficient_comparable_pairs"
  | "pairwise_agreement_below_minimum"
  | "top_choice_mismatch";

export type MixedAreaModelResult = Readonly<{
  model: string;
  predictedQuality: number;
  observedAverageJudgeScore: number;
  predictedRank: number;
  observedRank: number;
}>;

export type MixedAreaQualificationCaseReport = Readonly<{
  caseId: string;
  passed: boolean;
  predictedWinner?: string;
  observedWinner?: string;
  comparablePairCount: number;
  agreeingPairCount: number;
  pairwiseAgreement?: number;
  models: readonly MixedAreaModelResult[];
  failures: readonly MixedAreaQualificationFailureCode[];
}>;

export type MixedAreaQualificationReport = Readonly<{
  schemaVersion: typeof MIXED_AREA_QUALIFICATION_SCHEMA_VERSION;
  definitionSetDigest: string;
  evidenceDigest: string;
  passed: boolean;
  expectedCaseCount: number;
  observedCaseCount: number;
  comparablePairCount: number;
  agreeingPairCount: number;
  pairwiseAgreement?: number;
  cases: readonly MixedAreaQualificationCaseReport[];
  unexpectedCaseIds: readonly string[];
}>;

export class MixedAreaQualificationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MixedAreaQualificationConfigurationError";
  }
}

const CASE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;

function invalid(message: string): never {
  throw new MixedAreaQualificationConfigurationError(message);
}

function finiteBetween(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a finite number between ${String(minimum)} and ${String(maximum)}`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function catalogOf(snapshot: PublishedRoutingSnapshotV2): RoutingAreaCatalog {
  return {
    version: COMPOSITIONAL_ROUTING_VERSION,
    definitionSetDigest: snapshot.definitionSetDigest,
    areas: snapshot.areas
  };
}

function validateBenchmark(
  snapshot: PublishedRoutingSnapshotV2,
  benchmark: MixedAreaBenchmark
): void {
  try {
    assertPublishedRoutingSnapshotV2(snapshot);
  } catch {
    invalid("mixed-area qualification snapshot is invalid");
  }
  if (benchmark.definitionSetDigest !== snapshot.definitionSetDigest) {
    invalid("benchmark definition-set digest does not match the snapshot");
  }
  if (benchmark.evidenceDigest !== snapshot.evidenceDigest) {
    invalid("benchmark evidence digest does not match the snapshot");
  }
  if (!sameStrings(benchmark.candidateModels, snapshot.candidateModels)) {
    invalid("benchmark candidates must exactly match the snapshot in published order");
  }
  if (benchmark.cases.length === 0) invalid("mixed-area benchmark must contain cases");

  finiteBetween(
    benchmark.scoring.minimumPredictedQualityGap,
    0,
    1,
    "minimum predicted quality gap"
  );
  finiteBetween(
    benchmark.scoring.minimumObservedJudgeScoreGap,
    0,
    1,
    "minimum observed judge-score gap"
  );
  finiteBetween(benchmark.scoring.minimumPairwiseAgreement, 0, 1, "minimum pairwise agreement");
  if (
    !Number.isSafeInteger(benchmark.scoring.minimumComparablePairsPerCase) ||
    benchmark.scoring.minimumComparablePairsPerCase < 1 ||
    benchmark.scoring.minimumComparablePairsPerCase >
      (snapshot.candidateModels.length * (snapshot.candidateModels.length - 1)) / 2
  ) {
    invalid("minimum comparable pairs per case must be possible for the candidate count");
  }

  const catalog = catalogOf(snapshot);
  const seenCases = new Set<string>();
  for (const benchmarkCase of benchmark.cases) {
    if (!CASE_ID_PATTERN.test(benchmarkCase.id)) {
      invalid("mixed-area benchmark contains an invalid case id");
    }
    if (seenCases.has(benchmarkCase.id)) {
      invalid(`duplicate mixed-area benchmark case id: ${benchmarkCase.id}`);
    }
    seenCases.add(benchmarkCase.id);
    if (
      benchmarkCase.suiteDigest.length === 0 ||
      benchmarkCase.suiteDigest !== benchmarkCase.suiteDigest.trim() ||
      benchmarkCase.suiteDigest.length > 256
    ) {
      invalid(`mixed-area benchmark case ${benchmarkCase.id} has an invalid suite digest`);
    }
    try {
      assertExplicitEvalModel(benchmarkCase.judgeModel, "judge");
      assertRequestAreaDecomposition(benchmarkCase.decomposition, catalog);
    } catch {
      invalid(`mixed-area benchmark case ${benchmarkCase.id} has invalid routing metadata`);
    }
    const activeAreaCount = benchmarkCase.decomposition.weights.filter(
      ({ weight }) => weight > ROUTING_AREA_VECTOR_TOLERANCE
    ).length;
    if (benchmarkCase.decomposition.unknownWeight > ROUTING_AREA_VECTOR_TOLERANCE) {
      invalid(`mixed-area benchmark case ${benchmarkCase.id} must not contain unknown weight`);
    }
    if (activeAreaCount < 2) {
      invalid(`mixed-area benchmark case ${benchmarkCase.id} must activate at least two areas`);
    }
    const expected = new Set<string>();
    if (benchmarkCase.expectedCaseIds.length === 0) {
      invalid(`mixed-area benchmark case ${benchmarkCase.id} must contain expected case ids`);
    }
    for (const caseId of benchmarkCase.expectedCaseIds) {
      if (!CASE_ID_PATTERN.test(caseId)) {
        invalid(`mixed-area benchmark case ${benchmarkCase.id} has an invalid expected case id`);
      }
      if (expected.has(caseId)) {
        invalid(`mixed-area benchmark case ${benchmarkCase.id} has duplicate expected case ids`);
      }
      expected.add(caseId);
    }
  }
}

function decodeComparison(value: unknown): EvalComparisonResult | undefined {
  try {
    return Schema.decodeUnknownSync(EvalComparisonResultSchema)(value);
  } catch {
    return undefined;
  }
}

type ObservedModel = Readonly<{
  model: string;
  averageJudgeScore: number;
}>;

function inspectComparison(
  benchmarkCase: MixedAreaBenchmarkCase,
  comparison: EvalComparisonResult,
  candidateModels: readonly string[]
): Readonly<{
  observed: readonly ObservedModel[];
  failures: MixedAreaQualificationFailureCode[];
}> {
  const failures: MixedAreaQualificationFailureCode[] = [];
  if (comparison.profileId !== benchmarkCase.id) failures.push("profile_mismatch");
  if (comparison.suiteDigest !== benchmarkCase.suiteDigest) failures.push("suite_digest_mismatch");
  if (comparison.judgeModel !== benchmarkCase.judgeModel) failures.push("judge_mismatch");

  const expectedModels = new Set(candidateModels);
  const expectedCases = new Set(benchmarkCase.expectedCaseIds);
  const seenModels = new Set<string>();
  const observed: ObservedModel[] = [];
  for (const modelResult of comparison.models) {
    if (!expectedModels.has(modelResult.model)) {
      failures.push("unexpected_candidate");
      continue;
    }
    if (seenModels.has(modelResult.model)) {
      failures.push("duplicate_candidate");
      continue;
    }
    seenModels.add(modelResult.model);
    if (modelResult.cases.length !== expectedCases.size) failures.push("incomplete_cases");
    const seenCases = new Set<string>();
    let scoreTotal = 0;
    let validScores = 0;
    for (const result of modelResult.cases) {
      if (!expectedCases.has(result.caseId)) {
        failures.push("unknown_case");
        continue;
      }
      if (seenCases.has(result.caseId)) {
        failures.push("duplicate_case");
        continue;
      }
      seenCases.add(result.caseId);
      if (result.outcome === "unknown" || result.outcome === "cutoff") {
        failures.push("nonterminal_case");
      }
      if (result.measurement.judgeScore === undefined) {
        failures.push("missing_judge_score");
      } else {
        scoreTotal += result.measurement.judgeScore;
        validScores += 1;
      }
    }
    for (const expectedCaseId of expectedCases) {
      if (!seenCases.has(expectedCaseId)) failures.push("missing_case");
    }
    if (
      seenCases.size === expectedCases.size &&
      validScores === expectedCases.size &&
      modelResult.cases.length === expectedCases.size
    ) {
      observed.push({
        model: modelResult.model,
        averageJudgeScore: scoreTotal / expectedCases.size
      });
    }
  }
  for (const model of candidateModels) {
    if (!seenModels.has(model)) failures.push("missing_candidate");
  }
  return { observed, failures: [...new Set(failures)] };
}

type PredictedModel = Readonly<{
  model: string;
  quality: number;
}>;

function predictedModels(
  snapshot: PublishedRoutingSnapshotV2,
  benchmarkCase: MixedAreaBenchmarkCase
): readonly PredictedModel[] | undefined {
  // Composite eval judge scores validate the matrix's quality prediction.
  // Cost/latency/balanced/Pareto policies intentionally optimize a different
  // ordering and require separate observed objective measurements.
  if (benchmarkCase.objective.kind !== "highest-quality") return undefined;
  try {
    const decision = scoreRoutingCandidates({
      snapshot,
      decomposition: benchmarkCase.decomposition,
      requirements: benchmarkCase.requirements,
      objective: benchmarkCase.objective,
      availableModels: benchmarkCase.availableModels,
      ...(benchmarkCase.constraints === undefined ? {} : { constraints: benchmarkCase.constraints })
    });
    const predicted = decision.candidates.flatMap((candidate): PredictedModel[] =>
      candidate.eligible && candidate.quality !== undefined
        ? [{ model: candidate.model, quality: candidate.quality }]
        : []
    );
    return predicted.length === snapshot.candidateModels.length ? predicted : undefined;
  } catch {
    return undefined;
  }
}

function rankModels(
  values: readonly Readonly<{ model: string; value: number }>[]
): ReadonlyMap<string, number> {
  return new Map(
    [...values]
      .sort((left, right) => right.value - left.value || left.model.localeCompare(right.model))
      .map((entry, index) => [entry.model, index + 1] as const)
  );
}

function uniqueWinner(
  values: readonly Readonly<{ model: string; value: number }>[],
  minimumGap: number
): string | undefined {
  const ranked = [...values].sort(
    (left, right) => right.value - left.value || left.model.localeCompare(right.model)
  );
  const first = ranked[0];
  const second = ranked[1];
  if (first === undefined) return undefined;
  if (second !== undefined && first.value - second.value <= minimumGap) return undefined;
  return first.model;
}

function sanitizeUnexpectedId(caseId: string): string {
  return CASE_ID_PATTERN.test(caseId) ? caseId : "invalid-observation-id";
}

/**
 * Checks whether the first-order model-by-area quality matrix predicts model
 * ordering on independently judged composite suites. Reports retain only
 * digests, case identities, model identities, and aggregate scores.
 */
export function qualifyMixedAreaPredictions(
  input: Readonly<{
    snapshot: PublishedRoutingSnapshotV2;
    benchmark: MixedAreaBenchmark;
    observations: readonly MixedAreaQualificationObservation[];
  }>
): MixedAreaQualificationReport {
  validateBenchmark(input.snapshot, input.benchmark);
  const expectedById = new Map(input.benchmark.cases.map((entry) => [entry.id, entry] as const));
  const observations = new Map<string, MixedAreaQualificationObservation>();
  const duplicateIds = new Set<string>();
  const unexpectedIds = new Set<string>();
  for (const observation of input.observations) {
    if (!expectedById.has(observation.caseId)) {
      unexpectedIds.add(sanitizeUnexpectedId(observation.caseId));
    } else if (observations.has(observation.caseId)) {
      duplicateIds.add(observation.caseId);
    } else {
      observations.set(observation.caseId, observation);
    }
  }

  const cases = input.benchmark.cases.map((benchmarkCase): MixedAreaQualificationCaseReport => {
    const failures: MixedAreaQualificationFailureCode[] = [];
    if (duplicateIds.has(benchmarkCase.id)) failures.push("duplicate_observation");
    const observation = observations.get(benchmarkCase.id);
    if (observation === undefined) {
      failures.push("missing_observation");
      return {
        caseId: benchmarkCase.id,
        passed: false,
        comparablePairCount: 0,
        agreeingPairCount: 0,
        models: [],
        failures
      };
    }
    if ("failure" in observation) {
      failures.push("comparison_call_failed");
      return {
        caseId: benchmarkCase.id,
        passed: false,
        comparablePairCount: 0,
        agreeingPairCount: 0,
        models: [],
        failures
      };
    }
    const comparison = decodeComparison(observation.comparison);
    if (comparison === undefined) {
      failures.push("invalid_comparison");
      return {
        caseId: benchmarkCase.id,
        passed: false,
        comparablePairCount: 0,
        agreeingPairCount: 0,
        models: [],
        failures
      };
    }
    const inspection = inspectComparison(benchmarkCase, comparison, input.snapshot.candidateModels);
    failures.push(...inspection.failures);
    const predicted = predictedModels(input.snapshot, benchmarkCase);
    if (predicted === undefined) failures.push("scoring_failed");
    if (
      predicted === undefined ||
      inspection.observed.length !== input.snapshot.candidateModels.length
    ) {
      return {
        caseId: benchmarkCase.id,
        passed: false,
        comparablePairCount: 0,
        agreeingPairCount: 0,
        models: [],
        failures: [...new Set(failures)]
      };
    }

    const predictedByModel = new Map(
      predicted.map((entry) => [entry.model, entry.quality] as const)
    );
    const observedByModel = new Map(
      inspection.observed.map((entry) => [entry.model, entry.averageJudgeScore] as const)
    );
    let comparablePairCount = 0;
    let agreeingPairCount = 0;
    for (let leftIndex = 0; leftIndex < input.snapshot.candidateModels.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < input.snapshot.candidateModels.length;
        rightIndex += 1
      ) {
        const left = input.snapshot.candidateModels[leftIndex] as string;
        const right = input.snapshot.candidateModels[rightIndex] as string;
        const predictedDelta =
          (predictedByModel.get(left) as number) - (predictedByModel.get(right) as number);
        const observedDelta =
          (observedByModel.get(left) as number) - (observedByModel.get(right) as number);
        if (
          Math.abs(predictedDelta) <= input.benchmark.scoring.minimumPredictedQualityGap ||
          Math.abs(observedDelta) <= input.benchmark.scoring.minimumObservedJudgeScoreGap
        ) {
          continue;
        }
        comparablePairCount += 1;
        if (Math.sign(predictedDelta) === Math.sign(observedDelta)) agreeingPairCount += 1;
      }
    }
    if (comparablePairCount < input.benchmark.scoring.minimumComparablePairsPerCase) {
      failures.push("insufficient_comparable_pairs");
    }
    const pairwiseAgreement =
      comparablePairCount === 0 ? undefined : agreeingPairCount / comparablePairCount;
    if (
      pairwiseAgreement !== undefined &&
      pairwiseAgreement < input.benchmark.scoring.minimumPairwiseAgreement
    ) {
      failures.push("pairwise_agreement_below_minimum");
    }

    const predictedRanks = rankModels(
      predicted.map(({ model, quality }) => ({ model, value: quality }))
    );
    const observedRanks = rankModels(
      inspection.observed.map(({ model, averageJudgeScore }) => ({
        model,
        value: averageJudgeScore
      }))
    );
    const predictedWinner = uniqueWinner(
      predicted.map(({ model, quality }) => ({ model, value: quality })),
      input.benchmark.scoring.minimumPredictedQualityGap
    );
    const observedWinner = uniqueWinner(
      inspection.observed.map(({ model, averageJudgeScore }) => ({
        model,
        value: averageJudgeScore
      })),
      input.benchmark.scoring.minimumObservedJudgeScoreGap
    );
    if (
      predictedWinner !== undefined &&
      observedWinner !== undefined &&
      predictedWinner !== observedWinner
    ) {
      failures.push("top_choice_mismatch");
    }
    const models = input.snapshot.candidateModels.map(
      (model): MixedAreaModelResult => ({
        model,
        predictedQuality: predictedByModel.get(model) as number,
        observedAverageJudgeScore: observedByModel.get(model) as number,
        predictedRank: predictedRanks.get(model) as number,
        observedRank: observedRanks.get(model) as number
      })
    );
    return {
      caseId: benchmarkCase.id,
      passed: failures.length === 0,
      ...(predictedWinner === undefined ? {} : { predictedWinner }),
      ...(observedWinner === undefined ? {} : { observedWinner }),
      comparablePairCount,
      agreeingPairCount,
      ...(pairwiseAgreement === undefined ? {} : { pairwiseAgreement }),
      models,
      failures: [...new Set(failures)]
    };
  });

  const comparablePairCount = cases.reduce((sum, entry) => sum + entry.comparablePairCount, 0);
  const agreeingPairCount = cases.reduce((sum, entry) => sum + entry.agreeingPairCount, 0);
  const pairwiseAgreement =
    comparablePairCount === 0 ? undefined : agreeingPairCount / comparablePairCount;
  const unexpectedCaseIds = [...unexpectedIds].sort();
  return {
    schemaVersion: MIXED_AREA_QUALIFICATION_SCHEMA_VERSION,
    definitionSetDigest: input.snapshot.definitionSetDigest,
    evidenceDigest: input.snapshot.evidenceDigest,
    passed: cases.every((entry) => entry.passed) && unexpectedCaseIds.length === 0,
    expectedCaseCount: input.benchmark.cases.length,
    observedCaseCount: input.observations.length,
    comparablePairCount,
    agreeingPairCount,
    ...(pairwiseAgreement === undefined ? {} : { pairwiseAgreement }),
    cases,
    unexpectedCaseIds
  };
}
