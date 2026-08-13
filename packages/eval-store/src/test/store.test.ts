import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect } from "effect";

import { EVAL_CONTRACT_VERSION, type EvalRunResult } from "@velum-labs/routekit-eval-contracts";

import { makeEffectEvalStore } from "../effect-api.js";
import { createEvalStore } from "../store.js";

function sample(runId: string): EvalRunResult {
  return {
    version: EVAL_CONTRACT_VERSION,
    runId,
    suiteId: "suite",
    candidateModel: "openai/gpt-4o-mini",
    judgeModel: "openai/gpt-4o-mini",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    passed: 1,
    failed: 0,
    cases: [{ caseId: "c1", candidateOutput: "ok", passed: true }]
  };
}

test("raw eval runs are write-once and missing stays distinct from corrupt", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-store-"));
  try {
    const store = createEvalStore(root);
    const first = sample("run-1");
    store.writeRawRun(first);
    assert.deepEqual(store.readRawRun("run-1"), first);
    assert.equal(store.readRawRun("missing"), undefined);
    assert.throws(() => store.writeRawRun(first), /immutable/);
    const evidence = store.publish(first);
    assert.equal(evidence.runId, "run-1");
    assert.equal(store.readPublished()?.runId, "run-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Effect eval store façade preserves immutability", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-store-effect-"));
  try {
    const store = makeEffectEvalStore(root);
    await Effect.runPromise(store.writeRawRun(sample("run-2")));
    await assert.rejects(Effect.runPromise(store.writeRawRun(sample("run-2"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
