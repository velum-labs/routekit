import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EvalComparisonResult,
  RoutingProfile
} from "@velum-labs/routekit-eval-contracts";

import {
  aggregateModelEvidence,
  compileRoutingPolicy,
  EvalPolicyCompilationError
} from "../evidence.js";

const comparison: EvalComparisonResult = {
  version: 1,
  comparisonId: "comparison-1",
  profileId: "support",
  suiteDigest: "suite-digest",
  judgeModel: "openai/judge",
  startedAt: "2026-08-15T00:00:00.000Z",
  finishedAt: "2026-08-15T00:01:00.000Z",
  models: [
    {
      model: "openai/cheap",
      cases: [
        {
          caseId: "one",
          outcome: "passed",
          measurement: { judgeScore: 0.9, costUsd: 0.01, durationMs: 100 }
        },
        {
          caseId: "two",
          outcome: "passed",
          measurement: { judgeScore: 0.8, costUsd: 0.01, durationMs: 120 }
        }
      ]
    },
    {
      model: "anthropic/strong",
      cases: [
        {
          caseId: "one",
          outcome: "passed",
          measurement: { judgeScore: 1, costUsd: 0.04, durationMs: 80 }
        },
        {
          caseId: "two",
          outcome: "passed",
          measurement: { judgeScore: 1, costUsd: 0.04, durationMs: 90 }
        }
      ]
    }
  ]
};

const profile: RoutingProfile = {
  version: 1,
  id: "support",
  suite: ".routekit/evals/support/support.eval.ts",
  candidates: ["openai/cheap", "anthropic/strong"],
  judge: "openai/judge",
  eligibility: { minimumPassRate: 0.9 },
  objective: "lowest-cost"
};

test("evidence aggregation preserves measured values and computes p95", () => {
  const evidence = aggregateModelEvidence(comparison);
  assert.deepEqual(evidence[0], {
    model: "openai/cheap",
    sampleCount: 2,
    passedCount: 2,
    failedCount: 0,
    unknownCount: 0,
    cutoffCount: 0,
    passRate: 1,
    failureRate: 0,
    averageJudgeScore: 0.8500000000000001,
    averageCostUsd: 0.01,
    p95DurationMs: 120
  });
});

test("policy compiler selects the cheapest eligible model with stable fallbacks", () => {
  const policy = compileRoutingPolicy(profile, comparison);
  assert.equal(policy.selectedModel, "openai/cheap");
  assert.deepEqual(policy.fallbackModels, ["anthropic/strong"]);
  assert.equal(policy.rejected.length, 0);
  assert.match(policy.evidenceDigest, /^[a-f0-9]{64}$/u);
});

test("unknown and cutoff outcomes disqualify incomplete evidence", () => {
  const incomplete: EvalComparisonResult = {
    ...comparison,
    models: [
      {
        model: "openai/cheap",
        cases: [{ caseId: "one", outcome: "unknown", measurement: {} }]
      }
    ]
  };
  assert.throws(
    () =>
      compileRoutingPolicy(
        { ...profile, candidates: ["openai/cheap"] },
        incomplete
      ),
    (error) =>
      error instanceof EvalPolicyCompilationError &&
      error.rejected[0]?.reasons.includes("1 outcomes are unknown") === true
  );
});

test("missing objective measurements sort behind measured candidates", () => {
  const unmeasured: EvalComparisonResult = {
    ...comparison,
    models: [
      ...comparison.models,
      {
        model: "google/unpriced",
        cases: [{ caseId: "one", outcome: "passed", measurement: { judgeScore: 1 } }]
      }
    ]
  };
  const policy = compileRoutingPolicy(
    {
      ...profile,
      candidates: [...profile.candidates, "google/unpriced"]
    },
    unmeasured
  );
  assert.deepEqual(policy.fallbackModels, ["anthropic/strong", "google/unpriced"]);
});
