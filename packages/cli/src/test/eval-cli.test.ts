import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVAL_CONTRACT_VERSION, EVAL_POLICY } from "@velum-labs/routekit-eval-contracts";
import { makeEvalStore } from "@velum-labs/routekit-eval-store";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { evalRunCommand, evalShowCommand, policyShowCommand } from "../effect/eval-cli.js";

test("policy show command is an Effect program with the isolation contract", async () => {
  assert.deepEqual(await Effect.runPromise(policyShowCommand), EVAL_POLICY);
});

test("eval show command reads an immutable raw run", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-"));
  try {
    const store = makeEvalStore(root);
    await runRouteKitEffect(
      store.writeRawRun({
        version: EVAL_CONTRACT_VERSION,
        runId: "eval_test",
        suiteId: "suite",
        candidateModel: "openai/gpt-4o-mini",
        judgeModel: "openai/gpt-4o-mini",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        passed: 1,
        failed: 0,
        cases: [{ caseId: "c1", candidateOutput: "ok", passed: true }]
      })
    );
    const result = await runRouteKitEffect(
      evalShowCommand({ runId: "eval_test", storeRoot: root })
    );
    assert.equal(result.runId, "eval_test");
    assert.equal(result.passed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval run command rejects a malformed suite document", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-spec-"));
  try {
    const specPath = join(root, "suite.json");
    writeFileSync(specPath, "{");
    await assert.rejects(
      runRouteKitEffect(
        evalRunCommand({
          specPath,
          gatewayUrl: "http://127.0.0.1:9",
          token: "eval-token",
          storeRoot: root
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
