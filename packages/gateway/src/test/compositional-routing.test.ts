import assert from "node:assert/strict";
import test from "node:test";

import {
  type AutoRoutingDecision,
  COMPOSITIONAL_ROUTING_VERSION,
  type ModelDimensionEvidence,
  type PublishedRoutingActivation,
  type RequestDecomposition,
  type RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { CompositionalRoutingError, routeCompositionalRequest } from "../routing/compositional.js";
import {
  AutoRoutingUnavailableError,
  type CompositionalRoutingObservation,
  compositionalRoutingPolicyReaderFromSnapshot,
  resolveCompositionalAutoRoutingModel,
  resolveConfiguredAutoRoutingModel
} from "../routing/eval-policy.js";
import { makeFakeRequestDecomposer } from "../services/request-classifier/service.js";

const dimensions = [
  "code-change",
  "repository-navigation",
  "verification-debugging",
  "architecture-design",
  "technical-explanation"
].map((id) => ({
  id,
  description: `Tasks centered on ${id}`,
  includes: [`Includes ${id}`],
  excludes: [`Excludes work outside ${id}`]
}));

const models = ["openai/alpha", "openai/beta"] as const;

function evidenceCell(
  model: (typeof models)[number],
  dimensionId: string,
  options: Readonly<{
    quality: number;
    failureRate?: number;
    latency: number;
    cost: number;
  }>
): ModelDimensionEvidence {
  return {
    model,
    dimensionId,
    suiteDigest: `suite-${dimensionId}`,
    evidenceDigest: `evidence-${model}-${dimensionId}`,
    quality: {
      passRate: options.quality,
      lowerConfidenceBound: options.quality,
      sampleCount: 20
    },
    failureRate: options.failureRate ?? 0,
    p95DurationMs: options.latency,
    averageCostUsd: options.cost,
    unpricedCalls: 0
  };
}

function snapshot(): PublishedRoutingActivation {
  const evidence = dimensions.flatMap((dimension, index) => [
    evidenceCell("openai/alpha", dimension.id, {
      quality: index === 0 ? 0.95 : index === 1 ? 0.7 : 0.8,
      latency: 100,
      cost: 0.01
    }),
    evidenceCell("openai/beta", dimension.id, {
      quality: index === 0 ? 0.8 : index === 1 ? 0.95 : 0.9,
      latency: 200,
      cost: 0.02
    })
  ]);
  return {
    version: COMPOSITIONAL_ROUTING_VERSION,
    generatedAt: "2026-08-17T00:00:00.000Z",
    basisDigest: "definitions-v2",
    evidenceDigest: "matrix-v2",
    classifierModel: "openai/classifier",
    objective: { kind: "highest-quality" },
    maximumUnknownWeight: 0.2,
    dimensions,
    candidateModels: models,
    evidence
  };
}

function decomposition(unknownWeight = 0): RequestDecomposition {
  return {
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest: "definitions-v2",
    weights: dimensions.map((dimension, index) => ({
      dimensionId: dimension.id,
      weight: index === 0 ? 0.6 * (1 - unknownWeight) : index === 1 ? 0.4 * (1 - unknownWeight) : 0
    })),
    unknownWeight
  };
}

const availableModels = models.map((model) => ({
  model,
  served: true,
  endpoints: ["responses"] as const,
  supportsTools: true,
  supportsVision: false,
  maxInputTokens: 128_000,
  maxOutputTokens: 16_384
}));

const requirements = {
  endpoint: "responses" as const,
  requiresTools: false,
  requiresVision: false,
  inputTokens: 10_000,
  maxOutputTokens: 4_096
};

function route(
  objective: RoutingObjectivePolicy,
  overrides: Partial<Parameters<typeof routeCompositionalRequest>[0]> = {}
) {
  return routeCompositionalRequest({
    snapshot: snapshot(),
    decomposition: decomposition(),
    requirements,
    objective,
    availableModels,
    maximumUnknownWeight: 0.25,
    ...overrides
  });
}

test("routes a mixed-dimension request by deterministic matrix composition", () => {
  const decision = route({ kind: "highest-quality" });

  assert.equal(decision.selectedModel, "openai/beta");
  assert.deepEqual(decision.fallbackModels, ["openai/alpha"]);
  assert.deepEqual(
    decision.candidates.map(({ model, rank, eligible }) => ({ model, rank, eligible })),
    [
      { model: "openai/beta", rank: 1, eligible: true },
      { model: "openai/alpha", rank: 2, eligible: true }
    ]
  );
  assert.equal(decision.evidenceDigest, "matrix-v2");
  assert.equal(decision.decomposition.basisDigest, "definitions-v2");
});

test("excludes stale, unavailable, and capability-incompatible models", () => {
  const unavailable = route(
    { kind: "highest-quality" },
    {
      availableModels: [
        availableModels[0] as (typeof availableModels)[number],
        { ...(availableModels[1] as (typeof availableModels)[number]), served: false }
      ]
    }
  );
  assert.equal(unavailable.selectedModel, "openai/alpha");
  assert.deepEqual(unavailable.fallbackModels, []);
  assert.deepEqual(
    unavailable.candidates.find((candidate) => candidate.model === "openai/beta")?.exclusionReasons,
    ["model_not_served"]
  );

  assert.throws(
    () =>
      route(
        { kind: "highest-quality" },
        {
          requirements: { ...requirements, requiresVision: true }
        }
      ),
    (error: unknown) =>
      error instanceof CompositionalRoutingError && error.code === "no_eligible_models"
  );
});

test("fails closed when unknown request content exceeds policy", () => {
  assert.throws(
    () =>
      route(
        { kind: "highest-quality" },
        {
          decomposition: decomposition(0.3)
        }
      ),
    (error: unknown) =>
      error instanceof CompositionalRoutingError &&
      error.code === "unknown_weight_above_maximum" &&
      error.message === "request is not sufficiently covered by the published routing dimensions"
  );
});

test("rejects incomplete and mismatched evidence before scoring", () => {
  const complete = snapshot();
  const incomplete: PublishedRoutingActivation = {
    ...complete,
    evidence: complete.evidence.slice(1)
  };
  assert.throws(
    () => route({ kind: "highest-quality" }, { snapshot: incomplete }),
    (error: unknown) =>
      error instanceof CompositionalRoutingError &&
      error.code === "invalid_input" &&
      error.message.includes("missing model-dimension evidence")
  );

  assert.throws(
    () =>
      route(
        { kind: "highest-quality" },
        {
          decomposition: {
            ...decomposition(),
            basisDigest: "wrong-definitions"
          }
        }
      ),
    (error: unknown) =>
      error instanceof CompositionalRoutingError &&
      error.code === "invalid_input" &&
      error.message.includes("definition-set digest")
  );
});

test("applies each configured objective without classifier involvement", () => {
  const objectives: ReadonlyArray<readonly [RoutingObjectivePolicy, (typeof models)[number]]> = [
    [{ kind: "highest-quality" }, "openai/beta"],
    [{ kind: "lowest-cost", minimumQuality: 0.8 }, "openai/alpha"],
    [{ kind: "lowest-latency", minimumQuality: 0.8 }, "openai/alpha"],
    [
      {
        kind: "balanced",
        minimumQuality: 0.8,
        weights: { quality: 0.8, cost: 0.1, latency: 0.1 }
      },
      "openai/beta"
    ],
    [{ kind: "pareto", minimumQuality: 0.8, preference: "cost" }, "openai/alpha"]
  ];

  for (const [objective, expected] of objectives) {
    assert.equal(route(objective).selectedModel, expected, objective.kind);
  }
});

test("dimension quality floors prevent cross-dimension compensation", () => {
  const decision = route(
    { kind: "highest-quality" },
    {
      constraints: {
        minimumDimensionQuality: {
          "repository-navigation": 0.8
        }
      }
    }
  );

  assert.equal(decision.selectedModel, "openai/beta");
  assert.deepEqual(decision.fallbackModels, []);
  assert.deepEqual(
    decision.candidates.find((candidate) => candidate.model === "openai/alpha")?.exclusionReasons,
    ["quality_below_dimension_floor:repository-navigation"]
  );
});

test("online v2 resolution classifies once and records the reproducible decision", async () => {
  let classifierCalls = 0;
  let observed: AutoRoutingDecision | undefined;
  const resolved = await runRouteKitEffect(
    resolveCompositionalAutoRoutingModel({
      headers: {},
      model: "auto",
      requestText: "Implement a change and navigate the repository",
      requirements,
      policyReader: compositionalRoutingPolicyReaderFromSnapshot(snapshot()),
      classifier: makeFakeRequestDecomposer(() => {
        classifierCalls += 1;
        return {
          weights: decomposition().weights,
          unknownWeight: 0
        };
      }),
      availableModels,
      objective: { kind: "highest-quality" },
      maximumUnknownWeight: 0.25,
      onDecision: (decision) => {
        observed = decision;
      }
    })
  );

  assert.equal(resolved, "openai/beta");
  assert.equal(classifierCalls, 1);
  assert.equal(observed?.selectedModel, "openai/beta");
  assert.equal(observed?.evidenceDigest, "matrix-v2");
  assert.deepEqual(observed?.decomposition.weights, decomposition().weights);
});

test("online v2 resolution leaves explicit models untouched", async () => {
  let classifierCalls = 0;
  const resolved = await runRouteKitEffect(
    resolveCompositionalAutoRoutingModel({
      headers: {},
      model: "openai/explicit",
      requirements,
      policyReader: compositionalRoutingPolicyReaderFromSnapshot(undefined),
      classifier: makeFakeRequestDecomposer(() => {
        classifierCalls += 1;
        return { weights: decomposition().weights, unknownWeight: 0 };
      }),
      availableModels: [],
      objective: { kind: "highest-quality" },
      maximumUnknownWeight: 0
    })
  );

  assert.equal(resolved, "openai/explicit");
  assert.equal(classifierCalls, 0);
});

test("online v2 resolution fails closed without a snapshot or for unknown-heavy requests", async () => {
  await assert.rejects(
    runRouteKitEffect(
      resolveCompositionalAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "hello",
        requirements,
        policyReader: compositionalRoutingPolicyReaderFromSnapshot(undefined),
        classifier: makeFakeRequestDecomposer({
          weights: decomposition().weights,
          unknownWeight: 0
        }),
        availableModels,
        objective: { kind: "highest-quality" },
        maximumUnknownWeight: 0.25
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "no compositional routing snapshot is available"
  );

  await assert.rejects(
    runRouteKitEffect(
      resolveCompositionalAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "An out-of-domain request",
        requirements,
        policyReader: compositionalRoutingPolicyReaderFromSnapshot(snapshot()),
        classifier: makeFakeRequestDecomposer({
          weights: decomposition(0.5).weights,
          unknownWeight: 0.5
        }),
        availableModels,
        objective: { kind: "highest-quality" },
        maximumUnknownWeight: 0.25
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "request is not sufficiently covered by the published routing dimensions"
  );
});

test("configured auto routing uses only dimension decomposition and matrix scoring", async () => {
  const observations: string[] = [];
  const resolved = await runRouteKitEffect(
    resolveConfiguredAutoRoutingModel({
      headers: {},
      model: "auto",
      requestText: "Implement a change and navigate the repository",
      requirements,
      compositionalRouting: {
        policyReader: compositionalRoutingPolicyReaderFromSnapshot(snapshot()),
        classifier: makeFakeRequestDecomposer({
          weights: decomposition().weights,
          unknownWeight: 0
        }),
        availableModels,
        objective: { kind: "highest-quality" },
        maximumUnknownWeight: 0.25,
        onObservation: (observation) => {
          observations.push(
            observation.status === "decided"
              ? `decided:${observation.decision.selectedModel}`
              : observation.status
          );
        }
      }
    })
  );

  assert.equal(resolved, "openai/beta");
  assert.deepEqual(observations, ["decided:openai/beta"]);
});

test("configured auto routing fails closed and observes missing evidence", async () => {
  const observations: string[] = [];
  await assert.rejects(
    runRouteKitEffect(
      resolveConfiguredAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "Implement a change",
        requirements,
        compositionalRouting: {
          policyReader: compositionalRoutingPolicyReaderFromSnapshot(undefined),
          classifier: makeFakeRequestDecomposer({
            weights: decomposition().weights,
            unknownWeight: 0
          }),
          availableModels,
          objective: { kind: "highest-quality" },
          maximumUnknownWeight: 0.25,
          onObservation: (observation) => observations.push(observation.status)
        }
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "no compositional routing snapshot is available"
  );
  assert.deepEqual(observations, ["failed"]);
});

test("configured auto routing retains per-model rejection reasons", async () => {
  const observations: CompositionalRoutingObservation[] = [];
  await assert.rejects(
    runRouteKitEffect(
      resolveConfiguredAutoRoutingModel({
        headers: {},
        model: "auto",
        requestText: "Implement a change",
        requirements,
        compositionalRouting: {
          policyReader: compositionalRoutingPolicyReaderFromSnapshot(snapshot()),
          classifier: makeFakeRequestDecomposer({
            weights: decomposition().weights,
            unknownWeight: 0
          }),
          availableModels: availableModels.map((model) => ({
            ...model,
            served: false
          })),
          objective: { kind: "highest-quality" },
          maximumUnknownWeight: 0.25,
          onObservation: (observation) => observations.push(observation)
        }
      })
    ),
    (error: unknown) =>
      error instanceof AutoRoutingUnavailableError &&
      error.message === "no candidate model satisfies the routing requirements and objective"
  );
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation?.status, "failed");
  if (observation?.status !== "failed") return;
  assert.deepEqual(
    observation.candidates?.map(({ model, exclusionReasons }) => ({
      model,
      exclusionReasons
    })),
    availableModels.map(({ model }) => ({
      model,
      exclusionReasons: ["model_not_served"]
    }))
  );
});
