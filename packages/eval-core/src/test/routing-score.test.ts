import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ModelAreaEvidence,
  PublishedRoutingSnapshotV2,
  RequestAreaDecomposition,
  RequestRoutingRequirements,
  RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";

import {
  type RoutingModelAvailability,
  RoutingScoringError,
  scoreRoutingCandidates
} from "../routing-score.js";

const models = ["provider/alpha", "provider/beta", "provider/gamma"] as const;
const areas = [
  { id: "code", description: "Code changes", includes: ["implementation"], excludes: [] },
  { id: "docs", description: "Documentation", includes: ["writing"], excludes: [] }
] as const;

function cell(
  model: string,
  areaId: string,
  quality: number,
  options: {
    failureRate?: number;
    cost?: number;
    duration?: number;
    unpricedCalls?: number;
  } = {}
): ModelAreaEvidence {
  return {
    model,
    areaId,
    suiteDigest: `suite-${areaId}`,
    evidenceDigest: `evidence-${model}-${areaId}`,
    quality: { passRate: quality, lowerConfidenceBound: quality, sampleCount: 20 },
    failureRate: options.failureRate ?? 1 - quality,
    ...(options.duration === undefined ? {} : { p95DurationMs: options.duration }),
    ...(options.cost === undefined ? {} : { averageCostUsd: options.cost }),
    unpricedCalls: options.unpricedCalls ?? (options.cost === undefined ? 20 : 0)
  };
}

function snapshot(
  evidence: readonly ModelAreaEvidence[],
  candidateModels: readonly string[] = models
): PublishedRoutingSnapshotV2 {
  return {
    version: 2,
    generatedAt: "2026-08-17T00:00:00.000Z",
    definitionSetDigest: "definition-digest",
    evidenceDigest: "evidence-digest",
    areas,
    candidateModels,
    evidence
  };
}

const decomposition: RequestAreaDecomposition = {
  version: 2,
  definitionSetDigest: "definition-digest",
  weights: [
    { areaId: "code", weight: 0.54 },
    { areaId: "docs", weight: 0.36 }
  ],
  unknownWeight: 0.1
};

const requirements: RequestRoutingRequirements = {
  endpoint: "responses",
  requiresTools: false,
  requiresVision: false,
  inputTokens: 4_000,
  maxOutputTokens: 2_000
};

function available(model: string, overrides: Partial<RoutingModelAvailability> = {}) {
  return {
    model,
    served: true,
    endpoints: ["responses"] as const,
    supportsTools: true,
    supportsVision: true,
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    ...overrides
  } satisfies RoutingModelAvailability;
}

function run(
  evidence: readonly ModelAreaEvidence[],
  objective: RoutingObjectivePolicy = { kind: "highest-quality" },
  options: {
    candidateModels?: readonly string[];
    availableModels?: readonly RoutingModelAvailability[];
    requestDecomposition?: RequestAreaDecomposition;
  } = {}
) {
  return scoreRoutingCandidates({
    snapshot: snapshot(evidence, options.candidateModels),
    decomposition: options.requestDecomposition ?? decomposition,
    requirements,
    objective,
    availableModels: options.availableModels ?? models.map((model) => available(model))
  });
}

const completeEvidence = [
  cell(models[0], "code", 0.9, { cost: 3, duration: 100 }),
  cell(models[0], "docs", 0.6, { cost: 1, duration: 300 }),
  cell(models[1], "code", 0.75, { cost: 1, duration: 200 }),
  cell(models[1], "docs", 0.8, { cost: 1, duration: 200 }),
  cell(models[2], "code", 0.7, { cost: 0.5, duration: 80 }),
  cell(models[2], "docs", 0.7, { cost: 0.5, duration: 80 })
];

test("highest-quality aggregates covered area weights and is candidate-order invariant", () => {
  const first = run(completeEvidence);
  const reversed = run(
    [...completeEvidence].reverse(),
    { kind: "highest-quality" },
    {
      candidateModels: [...models].reverse()
    }
  );

  assert.equal(first.selectedModel, models[0]);
  assert.deepEqual(first.fallbackModels, [models[1], models[2]]);
  assert.deepEqual(
    first.candidates.map(({ model, rank }) => ({ model, rank })),
    reversed.candidates.map(({ model, rank }) => ({ model, rank }))
  );
  assert.equal(first.candidates[0]?.quality, 0.78);
  assert.ok(Math.abs((first.candidates[0]?.averageCostUsd ?? 0) - 2.2) < 1e-12);
  assert.equal(first.candidates[0]?.p95DurationMs, 180);
});

test("hard requirements exclude unserved and incapable candidates before scoring", () => {
  const result = run(
    completeEvidence,
    { kind: "highest-quality" },
    {
      availableModels: [
        available(models[0], { supportsTools: false }),
        available(models[1], { maxOutputTokens: 1_000 }),
        available(models[2])
      ]
    }
  );
  const withTools = scoreRoutingCandidates({
    snapshot: snapshot(completeEvidence),
    decomposition,
    requirements: { ...requirements, requiresTools: true },
    objective: { kind: "highest-quality" },
    availableModels: [
      available(models[0], { supportsTools: false }),
      available(models[1], { maxOutputTokens: 1_000 }),
      available(models[2])
    ]
  });

  assert.equal(result.selectedModel, models[0]);
  assert.deepEqual(result.candidates.find(({ model }) => model === models[1])?.exclusionReasons, [
    "output_token_limit_insufficient"
  ]);
  assert.deepEqual(
    withTools.candidates.find(({ model }) => model === models[0])?.exclusionReasons,
    ["tools_not_supported"]
  );
});

test("unknown numeric catalog limits do not claim a served model is incapable", () => {
  const result = run(completeEvidence, { kind: "highest-quality" }, {
    availableModels: models.map((model) =>
      available(model, {
        maxInputTokens: undefined,
        maxOutputTokens: undefined
      })
    )
  });

  assert.equal(result.selectedModel, models[0]);
  assert.deepEqual(
    result.candidates.map(({ exclusionReasons }) => exclusionReasons),
    [[], [], []]
  );
});

test("missing evidence and per-area quality floors fail candidates closed", () => {
  const missingLastCell = completeEvidence.filter(
    (entry) => !(entry.model === models[0] && entry.areaId === "docs")
  );
  const result = scoreRoutingCandidates({
    snapshot: snapshot(missingLastCell),
    decomposition,
    requirements,
    objective: { kind: "highest-quality" },
    availableModels: models.map((model) => available(model)),
    constraints: { minimumAreaQuality: { code: 0.72 } }
  });

  assert.equal(result.selectedModel, models[1]);
  assert.deepEqual(result.candidates.find(({ model }) => model === models[0])?.exclusionReasons, [
    "missing_evidence:docs"
  ]);
  assert.deepEqual(result.candidates.find(({ model }) => model === models[2])?.exclusionReasons, [
    "quality_below_area_floor:code"
  ]);
});

test("lowest-cost excludes partially unpriced candidates rather than treating cost as zero", () => {
  const evidence = completeEvidence.map((entry) =>
    entry.model === models[2] ? { ...entry, unpricedCalls: 1 } : entry
  );
  const result = run(evidence, { kind: "lowest-cost", minimumQuality: 0.65 });
  const unpriced = result.candidates.find(({ model }) => model === models[2]);

  assert.equal(result.selectedModel, models[1]);
  assert.equal(unpriced?.costStatus, "unavailable");
  assert.equal(unpriced?.averageCostUsd, undefined);
  assert.deepEqual(unpriced?.exclusionReasons, ["cost_unavailable"]);
});

test("lowest-latency applies the aggregate quality floor and requires latency evidence", () => {
  const evidence = completeEvidence.map((entry) =>
    entry.model === models[2] && entry.areaId === "docs"
      ? cell(models[2], "docs", 0.7, { cost: 0.5 })
      : entry
  );
  const result = run(evidence, { kind: "lowest-latency", minimumQuality: 0.72 });

  assert.equal(result.selectedModel, models[0]);
  assert.deepEqual(result.candidates.find(({ model }) => model === models[2])?.exclusionReasons, [
    "quality_below_minimum",
    "latency_unavailable"
  ]);
});

test("balanced objective normalizes metrics and honors explicit weights", () => {
  const result = run(completeEvidence, {
    kind: "balanced",
    minimumQuality: 0.65,
    weights: { quality: 0.2, cost: 0.2, latency: 0.6 }
  });

  assert.equal(result.selectedModel, models[2]);
  assert.equal(result.candidates[0]?.utility, 0.8);
  assert.ok((result.candidates[1]?.utility ?? 0) < (result.candidates[0]?.utility ?? 0));
});

test("pareto ranks each non-dominated frontier by the declared preference", () => {
  const evidence = [
    cell(models[0], "code", 0.9, { cost: 3, duration: 100 }),
    cell(models[0], "docs", 0.9, { cost: 3, duration: 100 }),
    cell(models[1], "code", 0.8, { cost: 2, duration: 200 }),
    cell(models[1], "docs", 0.8, { cost: 2, duration: 200 }),
    cell(models[2], "code", 0.7, { cost: 4, duration: 300 }),
    cell(models[2], "docs", 0.7, { cost: 4, duration: 300 })
  ];
  const result = run(evidence, {
    kind: "pareto",
    minimumQuality: 0.6,
    preference: "cost"
  });

  assert.equal(result.selectedModel, models[1]);
  assert.deepEqual(result.fallbackModels, [models[0], models[2]]);
});

test("invalid decompositions and balanced weights fail with a typed input error", () => {
  assert.throws(
    () =>
      run(
        completeEvidence,
        { kind: "highest-quality" },
        {
          requestDecomposition: { ...decomposition, unknownWeight: 0.2 }
        }
      ),
    (error) => error instanceof RoutingScoringError && error.code === "invalid_input"
  );
  assert.throws(
    () =>
      run(completeEvidence, {
        kind: "balanced",
        minimumQuality: 0,
        weights: { quality: 0.5, cost: 0.5, latency: 0.5 }
      }),
    (error) => error instanceof RoutingScoringError && error.code === "invalid_input"
  );
});

test("no eligible model returns sanitized candidate reasons in the typed error", () => {
  assert.throws(
    () => run(completeEvidence, { kind: "lowest-cost", minimumQuality: 0.99 }),
    (error) => {
      assert.ok(error instanceof RoutingScoringError);
      assert.equal(error.code, "no_eligible_models");
      assert.equal(error.candidates.length, 3);
      assert.ok(error.candidates.every((candidate) => !candidate.eligible));
      return true;
    }
  );
});
