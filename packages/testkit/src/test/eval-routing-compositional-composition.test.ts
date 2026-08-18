import assert from "node:assert/strict";
import test from "node:test";

import type {
  EvalComparisonResult,
  ModelDimensionEvidence,
  PublishedRoutingActivation,
  RequestDecomposition
} from "@velum-labs/routekit-eval-contracts";

import {
  type CompositionBenchmark,
  CompositionQualificationConfigurationError,
  type CompositionQualificationObservation,
  qualifyCompositionPredictions
} from "../eval-routing-compositional/composition-qualification.js";

const models = ["provider/alpha", "provider/beta", "provider/gamma"] as const;
const dimensionIds = [
  "dimension-a",
  "dimension-b",
  "dimension-c",
  "dimension-d",
  "dimension-e"
] as const;

function cell(model: string, dimensionId: string, quality: number): ModelDimensionEvidence {
  return {
    model,
    dimensionId,
    suiteDigest: `suite-${dimensionId}`,
    evidenceDigest: `evidence-${model}-${dimensionId}`,
    quality: { passRate: quality, lowerConfidenceBound: quality, sampleCount: 20 },
    failureRate: 1 - quality,
    averageJudgeScore: quality,
    p95DurationMs: 100,
    unpricedCalls: 20
  };
}

const qualities = {
  [models[0]]: [0.9, 0.5, 0.6, 0.6, 0.6],
  [models[1]]: [0.7, 0.8, 0.6, 0.6, 0.6],
  [models[2]]: [0.6, 0.6, 0.6, 0.6, 0.6]
} as const;

const snapshot: PublishedRoutingActivation = {
  version: 2,
  generatedAt: "2026-08-17T00:00:00.000Z",
  basisDigest: "definition-digest",
  evidenceDigest: "evidence-digest",
  classifierModel: "provider/classifier",
  objective: { kind: "highest-quality" },
  maximumUnknownWeight: 0.2,
  dimensions: dimensionIds.map((id) => ({
    id,
    description: `Definition for ${id}`,
    includes: [`Includes ${id}`],
    excludes: [`Excludes ${id}`]
  })),
  candidateModels: models,
  evidence: models.flatMap((model) =>
    dimensionIds.map((dimensionId, index) =>
      cell(model, dimensionId, qualities[model][index] as number)
    )
  )
};

const availableModels = models.map((model) => ({
  model,
  served: true,
  endpoints: ["responses" as const],
  supportsTools: true,
  supportsVision: false,
  maxInputTokens: 128_000,
  maxOutputTokens: 16_384
}));

function decomposition(weights: readonly number[]): RequestDecomposition {
  return {
    version: 2,
    basisDigest: snapshot.basisDigest,
    weights: dimensionIds.map((dimensionId, index) => ({
      dimensionId,
      weight: weights[index] as number
    })),
    unknownWeight: 0
  };
}

const benchmark: CompositionBenchmark = {
  basisDigest: snapshot.basisDigest,
  evidenceDigest: snapshot.evidenceDigest,
  candidateModels: models,
  cases: [
    {
      id: "composition-a-b",
      suiteDigest: "composition-a-b-suite",
      judgeModel: "provider/judge",
      expectedCaseIds: ["trial-one", "trial-two"],
      decomposition: decomposition([0.5, 0.5, 0, 0, 0]),
      requirements: {
        endpoint: "responses",
        requiresTools: true,
        requiresVision: false,
        inputTokens: 4_000,
        maxOutputTokens: 2_000
      },
      objective: { kind: "highest-quality" },
      availableModels,
      constraints: { maximumFailureRate: 0.5 }
    },
    {
      id: "composition-a-c",
      suiteDigest: "composition-a-c-suite",
      judgeModel: "provider/judge",
      expectedCaseIds: ["trial-one", "trial-two"],
      decomposition: decomposition([0.8, 0, 0.2, 0, 0]),
      requirements: {
        endpoint: "responses",
        requiresTools: false,
        requiresVision: false
      },
      objective: { kind: "highest-quality" },
      availableModels
    }
  ],
  scoring: {
    minimumPredictedQualityGap: 0.04,
    minimumObservedJudgeScoreGap: 0.04,
    minimumComparablePairsPerCase: 2,
    minimumPairwiseAgreement: 1
  }
};

function comparison(
  caseId: string,
  scores: Readonly<Record<string, readonly [number, number]>>,
  overrides: Partial<EvalComparisonResult> = {}
): EvalComparisonResult {
  const benchmarkCase = benchmark.cases.find((entry) => entry.id === caseId);
  assert.ok(benchmarkCase);
  return {
    version: 1,
    comparisonId: `comparison-${caseId}`,
    profileId: caseId,
    suiteDigest: benchmarkCase.suiteDigest,
    judgeModel: benchmarkCase.judgeModel,
    startedAt: "2026-08-17T00:00:00.000Z",
    finishedAt: "2026-08-17T00:01:00.000Z",
    models: models.map((model) => ({
      model,
      cases: benchmarkCase.expectedCaseIds.map((expectedCaseId, index) => ({
        caseId: expectedCaseId,
        outcome: "passed" as const,
        measurement: { judgeScore: scores[model]?.[index] as number }
      }))
    })),
    ...overrides
  };
}

const alignedScores: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> =
  {
    "composition-a-b": {
      [models[0]]: [0.7, 0.68],
      [models[1]]: [0.82, 0.8],
      [models[2]]: [0.58, 0.6]
    },
    "composition-a-c": {
      [models[0]]: [0.88, 0.86],
      [models[1]]: [0.7, 0.68],
      [models[2]]: [0.59, 0.61]
    }
  } as const;

function passingObservations(): CompositionQualificationObservation[] {
  return benchmark.cases.map((entry) => ({
    caseId: entry.id,
    comparison: comparison(entry.id, alignedScores[entry.id]!)
  }));
}

test("composition qualification accepts complete composite evidence whose ordering matches the matrix", () => {
  const report = qualifyCompositionPredictions({
    snapshot,
    benchmark,
    observations: passingObservations()
  });

  assert.equal(report.passed, true);
  assert.equal(report.expectedCaseCount, 2);
  assert.equal(report.comparablePairCount, 6);
  assert.equal(report.agreeingPairCount, 6);
  assert.equal(report.pairwiseAgreement, 1);
  assert.deepEqual(
    report.cases.map(({ caseId, predictedWinner, observedWinner }) => ({
      caseId,
      predictedWinner,
      observedWinner
    })),
    [
      {
        caseId: "composition-a-b",
        predictedWinner: models[1],
        observedWinner: models[1]
      },
      {
        caseId: "composition-a-c",
        predictedWinner: models[0],
        observedWinner: models[0]
      }
    ]
  );
});

test("composition qualification detects a systematic composite ordering reversal", () => {
  const reversed = passingObservations().map((observation) =>
    observation.caseId === "composition-a-b"
      ? {
          ...observation,
          comparison: comparison("composition-a-b", {
            [models[0]]: [0.9, 0.88],
            [models[1]]: [0.5, 0.52],
            [models[2]]: [0.7, 0.68]
          })
        }
      : observation
  );
  const report = qualifyCompositionPredictions({ snapshot, benchmark, observations: reversed });
  const failed = report.cases.find((entry) => entry.caseId === "composition-a-b");

  assert.equal(report.passed, false);
  assert.deepEqual(failed?.failures, ["pairwise_agreement_below_minimum", "top_choice_mismatch"]);
  assert.equal(failed?.predictedWinner, models[1]);
  assert.equal(failed?.observedWinner, models[0]);
});

test("composition qualification fails closed on incomplete, duplicate, and unjudged rows", () => {
  const malformed = comparison("composition-a-b", alignedScores["composition-a-b"]!);
  const first = malformed.models[0];
  const second = malformed.models[1];
  assert.ok(first);
  assert.ok(second);
  const report = qualifyCompositionPredictions({
    snapshot,
    benchmark,
    observations: [
      {
        caseId: "composition-a-b",
        comparison: {
          ...malformed,
          models: [
            {
              ...first,
              cases: [
                first.cases[0] as (typeof first.cases)[number],
                first.cases[0] as (typeof first.cases)[number]
              ]
            },
            {
              ...second,
              cases: second.cases.map((entry, index) =>
                index === 0 ? { ...entry, measurement: {} } : entry
              )
            },
            second
          ]
        }
      },
      passingObservations()[1] as ReturnType<typeof passingObservations>[number]
    ]
  });
  const failed = report.cases[0];

  assert.equal(report.passed, false);
  assert.ok(failed?.failures.includes("duplicate_case"));
  assert.ok(failed?.failures.includes("missing_judge_score"));
  assert.ok(failed?.failures.includes("duplicate_candidate"));
  assert.ok(failed?.failures.includes("missing_candidate"));
  assert.equal(failed?.models.length, 0);
});

test("composition qualification binds comparison identity and rejects extra observations", () => {
  const observations = passingObservations();
  observations[0] = {
    caseId: "composition-a-b",
    comparison: comparison("composition-a-b", alignedScores["composition-a-b"]!, {
      suiteDigest: "wrong-suite",
      judgeModel: "provider/wrong-judge"
    })
  };
  observations.push({
    caseId: "not-reviewed",
    comparison: { raw: "sensitive response must not enter the report" }
  });
  const report = qualifyCompositionPredictions({ snapshot, benchmark, observations });

  assert.equal(report.passed, false);
  assert.deepEqual(report.unexpectedCaseIds, ["not-reviewed"]);
  assert.deepEqual(report.cases[0]?.failures, ["suite_digest_mismatch", "judge_mismatch"]);
  assert.equal(JSON.stringify(report).includes("sensitive"), false);
});

test("composition qualification rejects a benchmark case that is not compositional", () => {
  assert.throws(
    () =>
      qualifyCompositionPredictions({
        snapshot,
        benchmark: {
          ...benchmark,
          cases: [
            {
              ...(benchmark.cases[0] as (typeof benchmark.cases)[number]),
              decomposition: decomposition([1, 0, 0, 0, 0])
            }
          ]
        },
        observations: []
      }),
    CompositionQualificationConfigurationError
  );
});

test("composition quality qualification fails closed for objectives requiring other observed metrics", () => {
  const lowestLatencyBenchmark: CompositionBenchmark = {
    ...benchmark,
    cases: [
      {
        ...(benchmark.cases[0] as (typeof benchmark.cases)[number]),
        objective: { kind: "lowest-latency", minimumQuality: 0 }
      }
    ]
  };
  const report = qualifyCompositionPredictions({
    snapshot,
    benchmark: lowestLatencyBenchmark,
    observations: [
      {
        caseId: "composition-a-b",
        comparison: comparison("composition-a-b", alignedScores["composition-a-b"]!)
      }
    ]
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.cases[0]?.failures, ["scoring_failed"]);
  assert.equal(report.cases[0]?.models.length, 0);
});
