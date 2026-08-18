import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER
} from "@velum-labs/routekit-eval-contracts";
import { Effect } from "effect";
import type { GatewayPrincipal } from "../http/auth.js";
import { startSwitchingGatewayProxy } from "../switching-proxy.js";

async function recordingTarget() {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> =
    [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      )
  };
}

test("eval session proxy admits only explicit allowed models within limits", async () => {
  const target = await recordingTarget();
  let calls = 0;
  const evalPrincipal: GatewayPrincipal = {
    id: "eval-session-1",
    label: "eval:qualification",
    role: "eval",
    evalSession: {
      sessionId: "eval-session-1",
      allowedModels: ["openai/gpt-5.6-luna"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      perCallOutputTokens: 8,
      admit: () => {
        calls += 1;
        return calls <= 1
          ? { admitted: true as const }
          : { admitted: false as const, reason: "call_limit" as const };
      }
    }
  };
  const proxy = await startSwitchingGatewayProxy({
    target: target.url,
    resolveDataPrincipal: (presented) => (presented === "eval-secret" ? evalPrincipal : undefined)
  });
  const post = (body: unknown) =>
    fetch(`${proxy.url()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer eval-secret",
        "content-type": "application/json",
        [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
          purpose: "eval",
          role: "candidate",
          runId: "run-1",
          caseId: "case-1"
        })
      },
      body: JSON.stringify(body)
    });
  try {
    assert.equal((await post({ model: "auto", max_output_tokens: 8, messages: [] })).status, 400);
    assert.equal(
      (
        await post({
          model: "openai/gpt-5.6-sol",
          max_output_tokens: 8,
          messages: []
        })
      ).status,
      400
    );
    assert.equal(
      (
        await post({
          model: "openai/gpt-5.6-luna",
          max_output_tokens: 9,
          messages: []
        })
      ).status,
      400
    );
    assert.equal(
      (
        await post({
          model: "openai/gpt-5.6-luna",
          max_output_tokens: 8,
          messages: []
        })
      ).status,
      200
    );
    assert.equal(
      (
        await post({
          model: "openai/gpt-5.6-luna",
          max_output_tokens: 8,
          messages: []
        })
      ).status,
      429
    );
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0]?.headers[EVAL_POLICY_BYPASS_HEADER], "1");
    assert.equal(typeof target.requests[0]?.headers[EVAL_ATTRIBUTION_HEADER], "string");
  } finally {
    await Effect.runPromise(proxy.close);
    await target.close();
  }
});

test("ordinary principals cannot spoof eval bypass headers", async () => {
  const target = await recordingTarget();
  const proxy = await startSwitchingGatewayProxy({
    target: target.url,
    resolveDataPrincipal: (presented) =>
      presented === "admin-secret" ? { id: "admin-1", label: "admin", role: "admin" } : undefined
  });
  try {
    const response = await fetch(`${proxy.url()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
        [EVAL_POLICY_BYPASS_HEADER]: "1",
        [EVAL_ATTRIBUTION_HEADER]: '{"purpose":"eval"}'
      },
      body: JSON.stringify({ model: "auto", messages: [] })
    });
    assert.equal(response.status, 200);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0]?.headers[EVAL_POLICY_BYPASS_HEADER], undefined);
    assert.equal(target.requests[0]?.headers[EVAL_ATTRIBUTION_HEADER], undefined);
  } finally {
    await Effect.runPromise(proxy.close);
    await target.close();
  }
});
