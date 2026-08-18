import { createHash } from "node:crypto";

import type {
  EvalComparisonCase,
  EvalComparisonResult,
  ModelDimensionEvidence,
  RoutingBasis
} from "@velum-labs/routekit-eval-contracts";
import {
  assertExplicitEvalModel,
  assertPublishedRoutingActivation,
  assertRoutingBasis,
  COMPOSITIONAL_ROUTING_VERSION
} from "@velum-labs/routekit-eval-contracts";

const WILSON_95_PERCENT_Z = 1.959963984540054;

export type DimensionComparisonEvidenceInput = {
  readonly dimensionId: string;
  readonly suiteDigest: string;
  readonly judgeModel: string;
  readonly expectedCaseIds: ReadonlyArray<string>;
  readonly comparison: EvalComparisonResult;
};

export type CompileDimensionEvidenceMatrixInput = {
  readonly basis: RoutingBasis;
  readonly candidateModels: ReadonlyArray<string>;
  readonly comparisons: ReadonlyArray<DimensionComparisonEvidenceInput>;
};

export type CompiledDimensionEvidenceMatrix = {
  readonly evidenceDigest: string;
  readonly evidence: ReadonlyArray<ModelDimensionEvidence>;
};

export class DimensionEvidenceCompilationError extends Error {
  override readonly name = "DimensionEvidenceCompilationError";
}

/**
 * Compile a complete, deterministic model-by-dimension matrix from sanitized
 * comparison results. Missing/duplicate cases, candidates, dimensions, judge
 * scores, and non-terminal outcomes fail closed.
 */
export function compileDimensionEvidenceMatrix(
  input: CompileDimensionEvidenceMatrixInput
): CompiledDimensionEvidenceMatrix {
  assertInputBasis(input.basis);
  const candidateModels = assertCandidateModels(input.candidateModels);
  const dimensionIds = new Set(input.basis.dimensions.map((dimension) => dimension.id));
  const comparisons = new Map<string, DimensionComparisonEvidenceInput>();

  for (const dimension of input.comparisons) {
    if (!dimensionIds.has(dimension.dimensionId)) {
      fail(`comparison contains unknown dimension ${JSON.stringify(dimension.dimensionId)}`);
    }
    if (comparisons.has(dimension.dimensionId)) {
      fail(`comparison contains duplicate dimension ${JSON.stringify(dimension.dimensionId)}`);
    }
    comparisons.set(dimension.dimensionId, dimension);
  }
  for (const dimension of input.basis.dimensions) {
    if (!comparisons.has(dimension.id)) {
      fail(`comparison is missing dimension ${JSON.stringify(dimension.id)}`);
    }
  }

  const evidence: ModelDimensionEvidence[] = [];
  for (const dimension of input.basis.dimensions) {
    const dimensionInput = comparisons.get(dimension.id)!;
    evidence.push(...compileDimension(dimensionInput, candidateModels));
  }
  evidence.sort(
    (left, right) =>
      left.model.localeCompare(right.model) || left.dimensionId.localeCompare(right.dimensionId)
  );
  const evidenceDigest = stableDigest(evidence);

  // Reuse the public contract's exhaustive matrix validation before returning
  // an artifact that can be handed to the v2 snapshot store.
  try {
    assertPublishedRoutingActivation({
      version: COMPOSITIONAL_ROUTING_VERSION,
      generatedAt: "1970-01-01T00:00:00.000Z",
      basisDigest: input.basis.basisDigest,
      evidenceDigest,
      classifierModel: "routekit/evidence-validator",
      objective: { kind: "highest-quality" },
      maximumUnknownWeight: 1,
      dimensions: [...input.basis.dimensions],
      candidateModels: [...candidateModels],
      evidence
    });
  } catch (cause) {
    fail(`compiled model-dimension evidence is invalid: ${detailOf(cause)}`);
  }
  return { evidenceDigest, evidence };
}

export function wilsonLowerBound95(passed: number, sampleCount: number): number {
  if (
    !Number.isInteger(passed) ||
    !Number.isInteger(sampleCount) ||
    passed < 0 ||
    sampleCount < 1 ||
    passed > sampleCount
  ) {
    fail("Wilson confidence inputs must be integer counts within the sample");
  }
  const proportion = passed / sampleCount;
  const zSquared = WILSON_95_PERCENT_Z ** 2;
  const denominator = 1 + zSquared / sampleCount;
  const center = proportion + zSquared / (2 * sampleCount);
  const margin =
    WILSON_95_PERCENT_Z *
    Math.sqrt(
      (proportion * (1 - proportion)) / sampleCount + zSquared / (4 * sampleCount * sampleCount)
    );
  return Math.max(0, (center - margin) / denominator);
}

function assertInputBasis(basis: RoutingBasis): void {
  try {
    assertRoutingBasis(basis);
  } catch (cause) {
    fail(`routing dimension basis is invalid: ${detailOf(cause)}`);
  }
}

function assertCandidateModels(models: ReadonlyArray<string>): string[] {
  if (models.length === 0) fail("candidate model list must not be empty");
  const seen = new Set<string>();
  for (const model of models) {
    try {
      assertExplicitEvalModel(model, "candidate");
    } catch (cause) {
      fail(detailOf(cause));
    }
    if (seen.has(model)) fail(`duplicate candidate model ${JSON.stringify(model)}`);
    seen.add(model);
  }
  return [...models].sort();
}

function compileDimension(
  input: DimensionComparisonEvidenceInput,
  candidateModels: ReadonlyArray<string>
): ModelDimensionEvidence[] {
  if (input.comparison.profileId !== input.dimensionId) {
    fail(
      `comparison profile ${JSON.stringify(input.comparison.profileId)} does not match dimension ${JSON.stringify(
        input.dimensionId
      )}`
    );
  }
  if (input.comparison.suiteDigest !== input.suiteDigest) {
    fail(`comparison suite digest does not match dimension ${JSON.stringify(input.dimensionId)}`);
  }
  if (input.comparison.judgeModel !== input.judgeModel) {
    fail(`comparison judge does not match dimension ${JSON.stringify(input.dimensionId)}`);
  }
  try {
    assertExplicitEvalModel(input.judgeModel, "judge");
  } catch (cause) {
    fail(detailOf(cause));
  }
  const expectedCaseIds = assertExpectedCaseIds(input.dimensionId, input.expectedCaseIds);
  const expectedModels = new Set(candidateModels);
  const seenModels = new Set<string>();
  const evidence: ModelDimensionEvidence[] = [];

  for (const modelResult of input.comparison.models) {
    if (!expectedModels.has(modelResult.model)) {
      fail(
        `dimension ${JSON.stringify(input.dimensionId)} contains unexpected candidate ${JSON.stringify(
          modelResult.model
        )}`
      );
    }
    if (seenModels.has(modelResult.model)) {
      fail(
        `dimension ${JSON.stringify(input.dimensionId)} contains duplicate candidate ${JSON.stringify(
          modelResult.model
        )}`
      );
    }
    seenModels.add(modelResult.model);
    evidence.push(
      compileCell({
        dimensionId: input.dimensionId,
        suiteDigest: input.suiteDigest,
        judgeModel: input.judgeModel,
        comparisonId: input.comparison.comparisonId,
        model: modelResult.model,
        cases: modelResult.cases,
        expectedCaseIds
      })
    );
  }
  for (const model of candidateModels) {
    if (!seenModels.has(model)) {
      fail(
        `dimension ${JSON.stringify(input.dimensionId)} is missing candidate ${JSON.stringify(model)}`
      );
    }
  }
  return evidence;
}

function assertExpectedCaseIds(dimensionId: string, caseIds: ReadonlyArray<string>): Set<string> {
  if (caseIds.length === 0) {
    fail(`dimension ${JSON.stringify(dimensionId)} must contain at least one expected case`);
  }
  const expected = new Set<string>();
  for (const caseId of caseIds) {
    if (caseId.length === 0 || caseId !== caseId.trim()) {
      fail(`dimension ${JSON.stringify(dimensionId)} contains an invalid expected case id`);
    }
    if (expected.has(caseId)) {
      fail(
        `dimension ${JSON.stringify(dimensionId)} contains duplicate expected case ${JSON.stringify(caseId)}`
      );
    }
    expected.add(caseId);
  }
  return expected;
}

type CompileCellInput = {
  readonly dimensionId: string;
  readonly suiteDigest: string;
  readonly judgeModel: string;
  readonly comparisonId: string;
  readonly model: string;
  readonly cases: ReadonlyArray<EvalComparisonCase>;
  readonly expectedCaseIds: ReadonlySet<string>;
};

function compileCell(input: CompileCellInput): ModelDimensionEvidence {
  if (input.cases.length !== input.expectedCaseIds.size) {
    fail(
      `candidate ${JSON.stringify(input.model)} in dimension ${JSON.stringify(
        input.dimensionId
      )} has ${String(input.cases.length)} cases; expected ${String(input.expectedCaseIds.size)}`
    );
  }
  const seenCases = new Set<string>();
  let passed = 0;
  let judgeScoreTotal = 0;
  let costTotal = 0;
  let unpricedCalls = 0;
  const durations: number[] = [];
  const digestCases: Array<Record<string, unknown>> = [];

  for (const result of input.cases) {
    if (!input.expectedCaseIds.has(result.caseId)) {
      fail(
        `candidate ${JSON.stringify(input.model)} in dimension ${JSON.stringify(
          input.dimensionId
        )} contains unknown case ${JSON.stringify(result.caseId)}`
      );
    }
    if (seenCases.has(result.caseId)) {
      fail(
        `candidate ${JSON.stringify(input.model)} in dimension ${JSON.stringify(
          input.dimensionId
        )} contains duplicate case ${JSON.stringify(result.caseId)}`
      );
    }
    seenCases.add(result.caseId);
    if (result.outcome === "unknown" || result.outcome === "cutoff") {
      fail(
        `candidate ${JSON.stringify(input.model)} in dimension ${JSON.stringify(
          input.dimensionId
        )} contains non-terminal case ${JSON.stringify(result.caseId)}`
      );
    }
    if (result.measurement.judgeScore === undefined) {
      fail(
        `candidate ${JSON.stringify(input.model)} in dimension ${JSON.stringify(
          input.dimensionId
        )} is missing a judge score for case ${JSON.stringify(result.caseId)}`
      );
    }
    if (result.outcome === "passed") passed += 1;
    judgeScoreTotal += result.measurement.judgeScore;
    if (result.measurement.costUsd === undefined) {
      unpricedCalls += 1;
    } else {
      costTotal += result.measurement.costUsd;
    }
    if (result.measurement.durationMs !== undefined) {
      durations.push(result.measurement.durationMs);
    }
    digestCases.push({
      caseId: result.caseId,
      outcome: result.outcome,
      measurement: {
        ...(result.measurement.costUsd === undefined
          ? {}
          : { costUsd: result.measurement.costUsd }),
        ...(result.measurement.durationMs === undefined
          ? {}
          : { durationMs: result.measurement.durationMs }),
        judgeScore: result.measurement.judgeScore,
        ...(result.measurement.inputTokens === undefined
          ? {}
          : { inputTokens: result.measurement.inputTokens }),
        ...(result.measurement.outputTokens === undefined
          ? {}
          : { outputTokens: result.measurement.outputTokens })
      }
    });
  }
  for (const caseId of input.expectedCaseIds) {
    if (!seenCases.has(caseId)) {
      fail(
        `candidate ${JSON.stringify(input.model)} in dimension ${JSON.stringify(
          input.dimensionId
        )} is missing case ${JSON.stringify(caseId)}`
      );
    }
  }

  digestCases.sort((left, right) => String(left.caseId).localeCompare(String(right.caseId)));
  const sampleCount = input.expectedCaseIds.size;
  const passRate = passed / sampleCount;
  const p95DurationMs = durations.length === sampleCount ? percentile95(durations) : undefined;
  return {
    model: input.model,
    dimensionId: input.dimensionId,
    suiteDigest: input.suiteDigest,
    evidenceDigest: stableDigest({
      dimensionId: input.dimensionId,
      suiteDigest: input.suiteDigest,
      judgeModel: input.judgeModel,
      comparisonId: input.comparisonId,
      model: input.model,
      cases: digestCases
    }),
    quality: {
      passRate,
      lowerConfidenceBound: wilsonLowerBound95(passed, sampleCount),
      sampleCount
    },
    failureRate: (sampleCount - passed) / sampleCount,
    averageJudgeScore: judgeScoreTotal / sampleCount,
    ...(p95DurationMs === undefined ? {} : { p95DurationMs }),
    ...(unpricedCalls === 0 ? { averageCostUsd: costTotal / sampleCount } : {}),
    unpricedCalls
  };
}

function percentile95(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fail(message: string): never {
  throw new DimensionEvidenceCompilationError(message);
}
