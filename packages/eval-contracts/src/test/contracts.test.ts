import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  AutoRoutingDecision,
  assertAutoRoutingDecision,
  assertDecompositionInput,
  assertDecompositionResult,
  assertExplicitEvalModel,
  assertPublishedRoutingActivation,
  assertRequestDecomposition,
  assertRoutingBasis,
  assertRoutingObjectivePolicy,
  assertRoutingProfile,
  COMPOSITIONAL_ROUTING_VERSION,
  DecompositionResult,
  EVAL_POLICY,
  EvalMeasurement,
  EvalSetupState,
  EvalSuiteSpec,
  isForbiddenEvalModel,
  ModelEvidence,
  PublishedRoutingActivation,
  PublishedRoutingSnapshot,
  RequestDecomposition,
  RoutingBasis,
  RoutingObjectivePolicy,
  RoutingProfile
} from "../index.js";

const routingAreas = [
  "gateway-protocol",
  "eval-routing",
  "account-pooling",
  "typescript-maintenance",
  "release-operations"
].map((id) => ({
  id,
  description: `Requests about ${id}`,
  includes: [`Tasks specifically involving ${id}`],
  excludes: [`Tasks unrelated to ${id}`]
}));

function makeRoutingBasis(): RoutingBasis {
  return Schema.decodeSync(RoutingBasis)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest: "definitions-v2",
    dimensions: routingAreas
  });
}

function makePublishedRoutingActivation(): PublishedRoutingActivation {
  const candidates = ["openai/model-a", "anthropic/model-b"];
  return Schema.decodeSync(PublishedRoutingActivation)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    generatedAt: "2026-08-17T00:00:00.000Z",
    basisDigest: "definitions-v2",
    evidenceDigest: "all-evidence-v2",
    classifierModel: "openai/classifier",
    objective: { kind: "highest-quality" },
    maximumUnknownWeight: 0.2,
    dimensions: routingAreas,
    candidateModels: candidates,
    evidence: candidates.flatMap((model) =>
      routingAreas.map((dimension) => ({
        model,
        dimensionId: dimension.id,
        suiteDigest: `suite-${dimension.id}`,
        evidenceDigest: `evidence-${model}-${dimension.id}`,
        quality: {
          passRate: 0.9,
          lowerConfidenceBound: 0.8,
          sampleCount: 20
        },
        failureRate: 0.1,
        p95DurationMs: 1_000,
        averageCostUsd: 0.01,
        unpricedCalls: 0
      }))
    )
  });
}

test("eval contracts forbid auto-router model ids", () => {
  assert.equal(isForbiddenEvalModel("auto"), true);
  assert.equal(isForbiddenEvalModel("openai/gpt-4o-mini"), false);
  assert.equal(isForbiddenEvalModel(" / "), true);
  assert.equal(isForbiddenEvalModel("openai/"), true);
  assert.equal(isForbiddenEvalModel("/model"), true);
  assert.throws(() => assertExplicitEvalModel("auto", "candidate"), /explicit provider\/model/);
  assert.equal(EVAL_POLICY.autoRouterForbidden, true);
  assert.equal(EVAL_POLICY.onlineRequestPathIsolated, true);
});

test("eval evidence schemas reject poisoned metric domains", () => {
  assert.throws(() => Schema.decodeSync(EvalMeasurement)({ costUsd: -1 }));
  assert.throws(() => Schema.decodeSync(EvalMeasurement)({ judgeScore: 2 }));
  assert.throws(() =>
    Schema.decodeSync(ModelEvidence)({
      model: "openai/model",
      sampleCount: -1,
      passedCount: 0,
      failedCount: 0,
      unknownCount: 0,
      cutoffCount: 0
    })
  );
});

test("eval suite schema rejects malformed documents", () => {
  assert.throws(() => Schema.decodeUnknownSync(EvalSuiteSpec)({ version: 1, id: "x" }));
  const spec = Schema.decodeSync(EvalSuiteSpec)({
    version: 1,
    id: "suite",
    candidateModel: "openai/candidate",
    judgeModel: "openai/judge",
    cases: [{ id: "c1", prompt: "hi" }]
  });
  assert.equal(spec.cases.length, 1);
});

test("routing profile contract freezes explicit candidate, judge, and objective inputs", () => {
  const profile = Schema.decodeSync(RoutingProfile)({
    version: 1,
    id: "support",
    suite: ".routekit/evals/support/support.eval.ts",
    candidates: ["openai/cheap", "anthropic/strong"],
    judge: "openai/judge",
    eligibility: { minimumPassRate: 0.9 },
    objective: "lowest-cost"
  });
  assert.doesNotThrow(() => assertRoutingProfile(profile));
  assert.throws(
    () => assertRoutingProfile({ ...profile, candidates: ["auto"] }),
    /explicit provider\/model/
  );
  assert.throws(
    () => assertRoutingProfile({ ...profile, candidates: ["openai/cheap", "openai/cheap"] }),
    /duplicate candidate/
  );
  assert.throws(
    () => assertRoutingProfile({ ...profile, id: "Support profile" }),
    /routing profile id must start/
  );
  const described = Schema.decodeSync(RoutingProfile)({
    ...profile,
    description: "Support replies grounded in product policy"
  });
  assert.equal(described.description, "Support replies grounded in product policy");
});

test("published routing snapshots contain compact online decisions", () => {
  const snapshot = Schema.decodeSync(PublishedRoutingSnapshot)({
    version: 1,
    generatedAt: "2026-08-15T00:00:00.000Z",
    profiles: {
      support: {
        selectedModel: "openai/cheap",
        fallbackModels: ["anthropic/strong"],
        objective: "lowest-cost",
        suiteDigest: "suite-digest",
        evidenceDigest: "evidence-digest",
        publishedAt: "2026-08-15T00:00:00.000Z",
        description: "Support replies",
        evidence: [
          {
            model: "openai/cheap",
            passRate: 1,
            averageJudgeScore: 0.9
          }
        ]
      }
    }
  });
  assert.equal(snapshot.profiles.support?.selectedModel, "openai/cheap");
  assert.equal(snapshot.profiles.support?.description, "Support replies");
  assert.equal(snapshot.profiles.support?.evidence?.[0]?.passRate, 1);
  assert.equal("token" in snapshot, false);
});

test("v2 dimension catalogs require bounded, unique, reviewable definitions", () => {
  const basis = makeRoutingBasis();
  assert.doesNotThrow(() => assertRoutingBasis(basis));
  assert.throws(
    () =>
      assertRoutingBasis({
        ...basis,
        dimensions: [...basis.dimensions, basis.dimensions[0]!]
      }),
    /duplicate routing dimension/
  );
  assert.throws(
    () =>
      assertRoutingBasis({
        ...basis,
        dimensions: basis.dimensions.slice(0, 4)
      }),
    /between 5 and 10 dimensions/
  );
  assert.throws(
    () =>
      assertRoutingBasis({
        ...basis,
        basisDigest: " "
      }),
    /definition-set digest/
  );
});

test("v2 classifier vectors cover exactly the basis and sum to one", () => {
  const basis = makeRoutingBasis();
  assert.doesNotThrow(() =>
    assertDecompositionInput({
      request: "Implement deterministic request routing",
      dimensions: basis.dimensions
    })
  );
  assert.throws(
    () =>
      assertDecompositionInput({
        request: " ",
        dimensions: basis.dimensions
      }),
    /must be non-empty/
  );
  const complete = Schema.decodeSync(DecompositionResult)({
    weights: basis.dimensions.map((dimension) => ({ dimensionId: dimension.id, weight: 0.18 })),
    unknownWeight: 0.1
  });
  assert.doesNotThrow(() => assertDecompositionResult(complete, basis));
  assert.throws(
    () => assertDecompositionResult({ ...complete, weights: complete.weights.slice(0, -1) }, basis),
    /missing routing dimension weight/
  );
  assert.throws(
    () =>
      assertDecompositionResult(
        { ...complete, weights: [...complete.weights.slice(0, -1), complete.weights[0]!] },
        basis
      ),
    /duplicate routing dimension weight/
  );
  assert.throws(
    () =>
      assertDecompositionResult(
        {
          ...complete,
          weights: [
            ...complete.weights.slice(0, -1),
            { dimensionId: "other-dimension", weight: 0.18 }
          ]
        },
        basis
      ),
    /unknown routing dimension weight/
  );
  assert.throws(
    () => assertDecompositionResult({ ...complete, unknownWeight: 0.2 }, basis),
    /must sum to one/
  );
  assert.throws(() =>
    Schema.decodeSync(DecompositionResult)({
      weights: [{ dimensionId: "gateway-protocol", weight: -0.1 }],
      unknownWeight: 1
    })
  );

  const decomposition = Schema.decodeSync(RequestDecomposition)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest: basis.basisDigest,
    ...complete
  });
  assert.doesNotThrow(() => assertRequestDecomposition(decomposition, basis));
  assert.throws(
    () => assertRequestDecomposition({ ...decomposition, basisDigest: "wrong-definitions" }, basis),
    /does not match/
  );
});

test("v2 objectives reject malformed and non-normalized policies", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(RoutingObjectivePolicy)({
      kind: "cheapest-at-any-cost"
    })
  );
  const balanced = Schema.decodeSync(RoutingObjectivePolicy)({
    kind: "balanced",
    minimumQuality: 0.8,
    weights: { quality: 0.5, cost: 0.2, latency: 0.2 }
  });
  assert.throws(() => assertRoutingObjectivePolicy(balanced), /must sum to one/);
  assert.equal(balanced.kind, "balanced");
  if (balanced.kind !== "balanced") throw new Error("expected balanced objective");
  assert.doesNotThrow(() =>
    assertRoutingObjectivePolicy({
      ...balanced,
      weights: { quality: 0.5, cost: 0.25, latency: 0.25 }
    })
  );
});

test("v2 snapshots require a complete, coherent model-dimension evidence matrix", () => {
  const snapshot = makePublishedRoutingActivation();
  assert.doesNotThrow(() => assertPublishedRoutingActivation(snapshot));
  assert.throws(
    () =>
      assertPublishedRoutingActivation({
        ...snapshot,
        evidence: snapshot.evidence.slice(0, -1)
      }),
    /missing model-dimension evidence/
  );
  assert.throws(
    () =>
      assertPublishedRoutingActivation({
        ...snapshot,
        evidence: [...snapshot.evidence, snapshot.evidence[0]!]
      }),
    /duplicate model-dimension evidence/
  );
  assert.throws(
    () =>
      assertPublishedRoutingActivation({
        ...snapshot,
        evidence: [
          ...snapshot.evidence.slice(0, -1),
          { ...snapshot.evidence.at(-1)!, model: "openai/unexpected" }
        ]
      }),
    /unknown candidate/
  );
  assert.throws(
    () =>
      assertPublishedRoutingActivation({
        ...snapshot,
        candidateModels: ["auto", "anthropic/model-b"]
      }),
    /explicit provider\/model/
  );
});

test("v2 evidence never represents partially unknown pricing as a known average", () => {
  const snapshot = makePublishedRoutingActivation();
  const [first, ...rest] = snapshot.evidence;
  assert.throws(
    () =>
      assertPublishedRoutingActivation({
        ...snapshot,
        evidence: [{ ...first!, unpricedCalls: 1 }, ...rest]
      }),
    /must not report an average cost/
  );
  assert.doesNotThrow(() =>
    assertPublishedRoutingActivation({
      ...snapshot,
      evidence: [{ ...first!, averageCostUsd: undefined, unpricedCalls: 20 }, ...rest]
    })
  );
  assert.throws(
    () =>
      assertPublishedRoutingActivation({
        ...snapshot,
        evidence: [{ ...first!, averageCostUsd: undefined, unpricedCalls: 0 }, ...rest]
      }),
    /must report its average cost/
  );
});

test("v2 decisions match their snapshot and rank only eligible candidates", () => {
  const snapshot = makePublishedRoutingActivation();
  const basis = makeRoutingBasis();
  const decision = Schema.decodeSync(AutoRoutingDecision)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    decomposition: {
      version: COMPOSITIONAL_ROUTING_VERSION,
      basisDigest: basis.basisDigest,
      weights: basis.dimensions.map((dimension) => ({ dimensionId: dimension.id, weight: 0.2 })),
      unknownWeight: 0
    },
    requirements: {
      endpoint: "responses",
      requiresTools: false,
      requiresVision: false
    },
    objective: { kind: "highest-quality" },
    evidenceDigest: snapshot.evidenceDigest,
    candidates: [
      {
        model: "openai/model-a",
        eligible: true,
        exclusionReasons: [],
        quality: 0.8,
        failureRate: 0.1,
        p95DurationMs: 1_000,
        averageCostUsd: 0.01,
        costStatus: "known",
        rank: 1
      },
      {
        model: "anthropic/model-b",
        eligible: true,
        exclusionReasons: [],
        quality: 0.79,
        failureRate: 0.1,
        p95DurationMs: 1_100,
        averageCostUsd: 0.02,
        costStatus: "known",
        rank: 2
      }
    ],
    selectedModel: "openai/model-a",
    fallbackModels: ["anthropic/model-b"]
  });
  assert.doesNotThrow(() => assertAutoRoutingDecision(decision, snapshot));
  assert.throws(
    () =>
      assertAutoRoutingDecision(
        {
          ...decision,
          candidates: [
            decision.candidates[0]!,
            {
              ...decision.candidates[1]!,
              eligible: false,
              exclusionReasons: ["not served"]
            }
          ]
        },
        snapshot
      ),
    /ineligible routing candidate/
  );
});

test("setup state schema captures a durable one-question-at-a-time checkpoint", () => {
  const state = Schema.decodeSync(EvalSetupState)({
    version: 1,
    profileId: "support",
    repositoryRoot: "/repo",
    stage: "criteria",
    revision: 3,
    updatedAt: "2026-08-15T00:00:00.000Z",
    openQuestion: "What makes an answer acceptable?",
    answers: {
      surface: "support reply generation",
      data: "existing fixtures"
    }
  });
  assert.equal(state.stage, "criteria");
  assert.equal(state.openQuestion, "What makes an answer acceptable?");
});
