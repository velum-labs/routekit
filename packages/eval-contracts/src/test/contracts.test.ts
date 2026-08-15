import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  assertRoutingProfile,
  assertExplicitEvalModel,
  EVAL_POLICY,
  EvalSetupState,
  EvalSuiteSpec,
  isForbiddenEvalModel,
  PublishedRoutingSnapshot,
  ROUTEKIT_ROUTING_PROFILE_HEADER,
  RoutingProfile
} from "../index.js";

test("eval contracts forbid auto-router model ids", () => {
  assert.equal(isForbiddenEvalModel("auto"), true);
  assert.equal(isForbiddenEvalModel("openai/gpt-4o-mini"), false);
  assert.throws(() => assertExplicitEvalModel("auto", "candidate"), /explicit provider\/model/);
  assert.equal(EVAL_POLICY.autoRouterForbidden, true);
  assert.equal(EVAL_POLICY.onlineRequestPathIsolated, true);
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
  assert.equal(ROUTEKIT_ROUTING_PROFILE_HEADER, "x-routekit-profile");
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
        publishedAt: "2026-08-15T00:00:00.000Z"
      }
    }
  });
  assert.equal(snapshot.profiles.support?.selectedModel, "openai/cheap");
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
