import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  EVAL_CONTRACT_VERSION,
  EVAL_POLICY_BYPASS_HEADER
} from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { aggregateEvalResults, runEvalSuite } from "../effect-api.js";

test("eval aggregation counts passes and failures", () => {
  assert.deepEqual(
    aggregateEvalResults([
      { caseId: "a", candidateOutput: "yes", passed: true },
      { caseId: "b", candidateOutput: "no", passed: false }
    ]),
    { passed: 1, failed: 1 }
  );
});

test("eval execution uses explicit models and the policy-bypass header", async () => {
  const seen: Array<{ model?: string; bypass?: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
      const bypass = request.headers[EVAL_POLICY_BYPASS_HEADER];
      seen.push({
        model: body.model,
        bypass: Array.isArray(bypass) ? bypass[0] : bypass
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: body.model === "openai/judge-mini" ? "pass" : "the sky is blue"
              }
            }
          ]
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const result = await runRouteKitEffect(
      runEvalSuite(
        {
          version: EVAL_CONTRACT_VERSION,
          id: "suite",
          candidateModel: "openai/candidate-mini",
          judgeModel: "openai/judge-mini",
          cases: [{ id: "c1", prompt: "What color is the sky?", expected: "blue" }]
        },
        { gatewayUrl: `http://127.0.0.1:${address.port}`, token: "eval-token" }
      )
    );
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      seen.map((entry) => entry.model),
      ["openai/candidate-mini", "openai/judge-mini"]
    );
    assert.ok(seen.every((entry) => entry.bypass === "1"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});

test("eval execution rejects auto-router models", async () => {
  await assert.rejects(
    runRouteKitEffect(
      runEvalSuite(
        {
          version: EVAL_CONTRACT_VERSION,
          id: "suite",
          candidateModel: "auto",
          judgeModel: "openai/judge-mini",
          cases: []
        },
        { gatewayUrl: "http://127.0.0.1:9", token: "eval-token" }
      )
    ),
    /explicit provider\/model/
  );
});
