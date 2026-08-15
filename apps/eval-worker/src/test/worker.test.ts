import assert from "node:assert/strict";
import { test } from "node:test";

import { EVAL_CONTRACT_VERSION } from "@velum-labs/routekit-eval-contracts";

import { handleEvalWorkerLine } from "../main.js";

test("eval worker JSONL protocol rejects unsupported envelopes", async () => {
  const response = await handleEvalWorkerLine(
    JSON.stringify({ version: 0, type: "run", id: "req-1" })
  );
  assert.equal(response.type, "error");
  assert.equal(response.id, "req-1");
});

test("eval worker JSONL protocol reports execution errors", async () => {
  const response = await handleEvalWorkerLine(
    JSON.stringify({
      version: EVAL_CONTRACT_VERSION,
      type: "run",
      id: "req-2",
      spec: {
        version: EVAL_CONTRACT_VERSION,
        id: "suite",
        candidateModel: "auto",
        judgeModel: "openai/judge-mini",
        cases: []
      },
      gatewayUrl: "http://127.0.0.1:9",
      token: "eval-token"
    })
  );
  assert.equal(response.type, "error");
  assert.match(response.error, /explicit provider\/model/);
});
