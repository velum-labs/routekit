import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  assertExplicitEvalModel,
  EVAL_POLICY,
  ExperimentManifest,
  EvalSuiteSpec,
  isForbiddenEvalModel
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

test("experiment manifest supports method-agnostic treatments", () => {
  const manifest = Schema.decodeUnknownSync(ExperimentManifest)({
    schemaVersion: 1,
    experimentId: "embedding-vs-luna",
    objective: "Compare two classifiers",
    code: {
      image: `runner@sha256:${"a".repeat(64)}`,
      sourceCommit: "b".repeat(40)
    },
    dataset: {
      id: "development-v1",
      hash: "c".repeat(64),
      role: "development"
    },
    matrix: {
      treatments: [
        {
          id: "embedding",
          executor: "local",
          configuration: {
            method: "embedding_knn",
            assistance: { retriever: "gitnexus", topK: 20 },
            representations: ["task", "repository"]
          },
          command: { executable: "node", args: ["runner.js"] }
        },
        {
          id: "luna",
          executor: "hosted-model",
          configuration: { model: "openrouter/luna" }
        }
      ],
      seeds: [181081]
    },
    tasks: [{ id: "task-1", inputArtifact: "datasets/sha256/input.json" }],
    schedule: {
      type: "paired_interleave",
      maximumHostedCallsInFlight: 16,
      maximumSandboxes: 4
    },
    selection: {
      primaryMetric: "area_brier",
      secondaryMetrics: ["area_hit_at_1"],
      maximumPromotedTreatments: 1
    },
    budget: { providerMaximumUsd: 20, vercelMaximumUsd: 25 },
    dataAccess: { lockedTest: false }
  });
  assert.equal(manifest.matrix.treatments.length, 2);
  assert.equal(manifest.matrix.treatments[0]?.executor, "local");
  assert.deepEqual(manifest.matrix.treatments[0]?.configuration.assistance, {
    retriever: "gitnexus",
    topK: 20
  });
});
