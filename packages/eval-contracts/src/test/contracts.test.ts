import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import {
  EVAL_CONTRACT_VERSION,
  EVAL_POLICY,
  isForbiddenEvalModel,
  NormalizedEvalObservation,
  StoredEvalRun,
  validateExplicitEvalModel
} from "../index.js";

test("eval contracts forbid auto-router model ids", async () => {
  assert.equal(isForbiddenEvalModel("auto"), true);
  assert.equal(isForbiddenEvalModel("openai/gpt-4o-mini"), false);
  await assert.rejects(
    Effect.runPromise(validateExplicitEvalModel("auto", "candidate")),
    /explicit provider\/model/
  );
  assert.equal(EVAL_POLICY.autoRouterForbidden, true);
  assert.equal(EVAL_POLICY.onlineRequestPathIsolated, true);
});

test("run evidence requires reproducibility metadata", () => {
  assert.throws(() => Schema.decodeUnknownSync(StoredEvalRun)({ version: 2 }));
  const run = Schema.decodeSync(StoredEvalRun)({
    version: EVAL_CONTRACT_VERSION,
    manifest: {
      version: EVAL_CONTRACT_VERSION,
      runId: "eval_1",
      suiteId: "suite",
      suiteDigest: "abc",
      workloadId: "support",
      candidateModel: "openai/candidate",
      judgeModel: "openai/judge",
      engineVersion: "engine-v1",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      evaluator: { kind: "engine", name: "routekit" }
    },
    engine: {
      searchRoot: "/evals",
      workingDirectory: "/",
      files: [],
      exitCode: 0,
      results: [],
      tests: [],
      durationMs: 1,
      stdout: "",
      stderr: ""
    }
  });
  assert.equal(run.manifest.workloadId, "support");
});

test("normalized observations preserve unknown measurements as absent", () => {
  const observation = Schema.decodeSync(NormalizedEvalObservation)({
    version: EVAL_CONTRACT_VERSION,
    runId: "eval_1",
    suiteId: "suite",
    suiteDigest: "abc",
    workloadId: "support",
    candidateModel: "openai/candidate",
    judgeModel: "openai/judge",
    engineVersion: "engine-v1",
    role: "candidate",
    model: "openai/candidate",
    outcome: "unknown",
    cutOff: true,
    evaluator: { kind: "assertion", name: "ori-run-assertions" }
  });
  assert.equal("score" in observation, false);
  assert.equal("durationMs" in observation, false);
  assert.equal("usage" in observation, false);
  assert.equal("caseId" in observation, false);
});
