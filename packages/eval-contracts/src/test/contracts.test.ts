import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  AreaClassificationResult,
  AutoRoutingDecisionV2,
  assertAreaClassificationInput,
  assertAreaClassificationResult,
  assertAutoRoutingDecisionV2,
  assertExplicitEvalModel,
  assertPublishedRoutingSnapshotV2,
  assertRequestAreaDecomposition,
  assertRoutingAreaCatalog,
  assertRoutingObjectivePolicy,
  assertRoutingProfile,
  COMPOSITIONAL_ROUTING_VERSION,
  EVAL_POLICY,
  EvalMeasurement,
  EvalSetupState,
  EvalSuiteSpec,
  isForbiddenEvalModel,
  ModelEvidence,
  PublishedRoutingSnapshot,
  PublishedRoutingSnapshotV2,
  RequestAreaDecomposition,
  RoutingAreaCatalog,
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

function makeRoutingAreaCatalog(): RoutingAreaCatalog {
  return Schema.decodeSync(RoutingAreaCatalog)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    definitionSetDigest: "definitions-v2",
    areas: routingAreas
  });
}

function makePublishedRoutingSnapshotV2(): PublishedRoutingSnapshotV2 {
  const candidates = ["openai/model-a", "anthropic/model-b"];
  return Schema.decodeSync(PublishedRoutingSnapshotV2)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    generatedAt: "2026-08-17T00:00:00.000Z",
    definitionSetDigest: "definitions-v2",
    evidenceDigest: "all-evidence-v2",
    areas: routingAreas,
    candidateModels: candidates,
    evidence: candidates.flatMap((model) =>
      routingAreas.map((area) => ({
        model,
        areaId: area.id,
        suiteDigest: `suite-${area.id}`,
        evidenceDigest: `evidence-${model}-${area.id}`,
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

test("v2 area catalogs require bounded, unique, reviewable definitions", () => {
  const catalog = makeRoutingAreaCatalog();
  assert.doesNotThrow(() => assertRoutingAreaCatalog(catalog));
  assert.throws(
    () =>
      assertRoutingAreaCatalog({
        ...catalog,
        areas: [...catalog.areas, catalog.areas[0]!]
      }),
    /duplicate routing area/
  );
  assert.throws(
    () =>
      assertRoutingAreaCatalog({
        ...catalog,
        areas: catalog.areas.slice(0, 4)
      }),
    /between 5 and 10 areas/
  );
  assert.throws(
    () =>
      assertRoutingAreaCatalog({
        ...catalog,
        definitionSetDigest: " "
      }),
    /definition-set digest/
  );
});

test("v2 classifier vectors cover exactly the catalog and sum to one", () => {
  const catalog = makeRoutingAreaCatalog();
  assert.doesNotThrow(() =>
    assertAreaClassificationInput({
      request: "Implement deterministic request routing",
      areas: catalog.areas
    })
  );
  assert.throws(
    () =>
      assertAreaClassificationInput({
        request: " ",
        areas: catalog.areas
      }),
    /must be non-empty/
  );
  const complete = Schema.decodeSync(AreaClassificationResult)({
    weights: catalog.areas.map((area) => ({ areaId: area.id, weight: 0.18 })),
    unknownWeight: 0.1
  });
  assert.doesNotThrow(() => assertAreaClassificationResult(complete, catalog));
  assert.throws(
    () =>
      assertAreaClassificationResult(
        { ...complete, weights: complete.weights.slice(0, -1) },
        catalog
      ),
    /missing routing area weight/
  );
  assert.throws(
    () =>
      assertAreaClassificationResult(
        { ...complete, weights: [...complete.weights.slice(0, -1), complete.weights[0]!] },
        catalog
      ),
    /duplicate routing area weight/
  );
  assert.throws(
    () =>
      assertAreaClassificationResult(
        {
          ...complete,
          weights: [...complete.weights.slice(0, -1), { areaId: "other-area", weight: 0.18 }]
        },
        catalog
      ),
    /unknown routing area weight/
  );
  assert.throws(
    () => assertAreaClassificationResult({ ...complete, unknownWeight: 0.2 }, catalog),
    /must sum to one/
  );
  assert.throws(() =>
    Schema.decodeSync(AreaClassificationResult)({
      weights: [{ areaId: "gateway-protocol", weight: -0.1 }],
      unknownWeight: 1
    })
  );

  const decomposition = Schema.decodeSync(RequestAreaDecomposition)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    definitionSetDigest: catalog.definitionSetDigest,
    ...complete
  });
  assert.doesNotThrow(() => assertRequestAreaDecomposition(decomposition, catalog));
  assert.throws(
    () =>
      assertRequestAreaDecomposition(
        { ...decomposition, definitionSetDigest: "wrong-definitions" },
        catalog
      ),
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

test("v2 snapshots require a complete, coherent model-area evidence matrix", () => {
  const snapshot = makePublishedRoutingSnapshotV2();
  assert.doesNotThrow(() => assertPublishedRoutingSnapshotV2(snapshot));
  assert.throws(
    () =>
      assertPublishedRoutingSnapshotV2({
        ...snapshot,
        evidence: snapshot.evidence.slice(0, -1)
      }),
    /missing model-area evidence/
  );
  assert.throws(
    () =>
      assertPublishedRoutingSnapshotV2({
        ...snapshot,
        evidence: [...snapshot.evidence, snapshot.evidence[0]!]
      }),
    /duplicate model-area evidence/
  );
  assert.throws(
    () =>
      assertPublishedRoutingSnapshotV2({
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
      assertPublishedRoutingSnapshotV2({
        ...snapshot,
        candidateModels: ["auto", "anthropic/model-b"]
      }),
    /explicit provider\/model/
  );
});

test("v2 evidence never represents partially unknown pricing as a known average", () => {
  const snapshot = makePublishedRoutingSnapshotV2();
  const [first, ...rest] = snapshot.evidence;
  assert.throws(
    () =>
      assertPublishedRoutingSnapshotV2({
        ...snapshot,
        evidence: [{ ...first!, unpricedCalls: 1 }, ...rest]
      }),
    /must not report an average cost/
  );
  assert.doesNotThrow(() =>
    assertPublishedRoutingSnapshotV2({
      ...snapshot,
      evidence: [{ ...first!, averageCostUsd: undefined, unpricedCalls: 20 }, ...rest]
    })
  );
  assert.throws(
    () =>
      assertPublishedRoutingSnapshotV2({
        ...snapshot,
        evidence: [{ ...first!, averageCostUsd: undefined, unpricedCalls: 0 }, ...rest]
      }),
    /must report its average cost/
  );
});

test("v2 decisions match their snapshot and rank only eligible candidates", () => {
  const snapshot = makePublishedRoutingSnapshotV2();
  const catalog = makeRoutingAreaCatalog();
  const decision = Schema.decodeSync(AutoRoutingDecisionV2)({
    version: COMPOSITIONAL_ROUTING_VERSION,
    decomposition: {
      version: COMPOSITIONAL_ROUTING_VERSION,
      definitionSetDigest: catalog.definitionSetDigest,
      weights: catalog.areas.map((area) => ({ areaId: area.id, weight: 0.2 })),
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
  assert.doesNotThrow(() => assertAutoRoutingDecisionV2(decision, snapshot));
  assert.throws(
    () =>
      assertAutoRoutingDecisionV2(
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
