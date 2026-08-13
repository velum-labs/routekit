import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVAL_CONTRACT_VERSION, type EvalRunResult } from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { makeEvalStore } from "../store.js";

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

test("raw eval runs are write-once and missing stays distinct from corrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-store-"));
  try {
    const store = makeEvalStore(root);
    const first = sample("run-1");
    await runRouteKitEffect(store.writeRawRun(first));
    assert.deepEqual(await runRouteKitEffect(store.readRawRun("run-1")), first);
    assert.equal(await runRouteKitEffect(store.readRawRun("missing")), undefined);
    await assert.rejects(runRouteKitEffect(store.writeRawRun(first)), /immutable/);
    const evidence = await runRouteKitEffect(store.publish(first));
    assert.equal(evidence.runId, "run-1");
    assert.equal((await runRouteKitEffect(store.readPublished()))?.runId, "run-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
