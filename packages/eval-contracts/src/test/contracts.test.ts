import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  assertExplicitEvalModel,
  assertRoutingProfile,
  ClassificationInput,
  ClassificationResult,
  EVAL_POLICY,
  EvalMeasurement,
  EvalSetupState,
  EvalSuiteSpec,
  isForbiddenEvalModel,
  ModelEvidence,
  PublishedRoutingSnapshot,
  ROUTEKIT_ROUTING_PROFILE_HEADER,
  RoutingProfile
} from "../index.js";

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
  assert.equal(ROUTEKIT_ROUTING_PROFILE_HEADER, "x-routekit-profile");
  const described = Schema.decodeSync(RoutingProfile)({
    ...profile,
    description: "Support replies grounded in product policy"
  });
  assert.equal(described.description, "Support replies grounded in product policy");
});

test("classification contracts carry request text and a profile probability vector", () => {
  const input = Schema.decodeSync(ClassificationInput)({
    request: "Fix the React useEffect loop",
    profiles: [
      {
        id: "react",
        description: "Frontend React work",
        selectedModel: "openai/gpt-5.6-sol",
        fallbackModels: ["openai/gpt-5.6-terra"],
        evidence: [{ model: "openai/gpt-5.6-sol", passRate: 1, averageJudgeScore: 0.99 }]
      },
      {
        id: "backend",
        description: "API and server work",
        selectedModel: "openai/gpt-5.6-terra",
        fallbackModels: [],
        evidence: [{ model: "openai/gpt-5.6-terra", passRate: 0.92 }]
      }
    ]
  });
  assert.equal(input.profiles.length, 2);
  const result = Schema.decodeSync(ClassificationResult)({
    scores: [
      { profileId: "react", probability: 0.86 },
      { profileId: "backend", probability: 0.14 }
    ]
  });
  assert.equal(result.scores[0]?.profileId, "react");
  assert.throws(() =>
    Schema.decodeSync(ClassificationResult)({
      scores: [{ profileId: "react", probability: 1.1 }]
    })
  );
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
