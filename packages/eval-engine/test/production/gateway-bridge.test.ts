import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect } from "effect";

import { makeRouteKitEvalGatewayBridge } from "../../src/library/gateway-bridge.ts";

interface RecordedRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: IncomingMessage["headers"];
  readonly url: string | undefined;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const startGateway = async (
  handler: (request: RecordedRequest, response: ServerResponse) => void
) => {
  const server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readBody(request)) as Readonly<Record<string, unknown>>;
      handler({ body, headers: request.headers, url: request.url }, response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
};

const command = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  commandId: "command-1",
  comparisonId: "comparison-1",
  model: "openai/candidate",
  prompt: "Answer this",
  role: "candidate",
  runKey: "case-1",
  type: "agent.invoke",
  ...overrides
});

const invokeBridge = async (
  gatewayOrigin: string,
  bearerCredential: string,
  input: Readonly<Record<string, unknown>>
): Promise<Response> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeRouteKitEvalGatewayBridge({
          gatewayOrigin,
          bearerCredential
        });
        return yield* Effect.tryPromise((signal) =>
          fetch(`${bridge.origin}/api/invoke`, {
            body: JSON.stringify(input),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal
          })
        );
      })
    ).pipe(Effect.provide(NodeHttpClient.layerUndici))
  );

const readEvents = async (response: Response) =>
  (await response.text())
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          event: { type: string; payload: Record<string, unknown> };
        }
    );

test("gateway bridge forwards auth, bypass, attribution, and structured judge output", async () => {
  const calls: RecordedRequest[] = [];
  const gateway = await startGateway((request, response) => {
    calls.push(request);
    sendJson(response, 200, {
      id: "completion-1",
      model: "openai/judge",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"pass":true,"reason":"good","score":0.9}' },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, cost_usd: 0.004 }
    });
  });
  try {
    const response = await invokeBridge(
      gateway.origin,
      "super-secret-token",
      command({
        model: "openai/judge",
        role: "judge",
        outputSchema: {
          name: "judge verdict",
          schema: { type: "object", required: ["pass", "reason", "score"] }
        },
        parameters: { reasoning: { effort: "high" } }
      })
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.authorization, "Bearer super-secret-token");
    assert.equal(calls[0]?.headers["x-routekit-eval-policy-bypass"], "1");
    assert.deepEqual(JSON.parse(String(calls[0]?.headers["x-routekit-eval-attribution"])), {
      purpose: "eval",
      role: "judge",
      runId: "comparison-1",
      caseId: "case-1"
    });
    assert.equal(calls[0]?.body.stream, false);
    assert.equal(calls[0]?.body.reasoning_effort, "high");
    assert.deepEqual(calls[0]?.body.response_format, {
      type: "json_schema",
      json_schema: {
        name: "judge_verdict",
        schema: { type: "object", required: ["pass", "reason", "score"] },
        strict: true
      }
    });

    const events = await readEvents(response);
    assert.ok(events.every((entry) => entry.type === "runtime.event"));
    assert.equal(
      events.find((entry) => entry.event.type === "assistant.text.delta")?.event.payload.delta,
      '{"pass":true,"reason":"good","score":0.9}'
    );
    assert.deepEqual(
      events.find((entry) => entry.event.type === "item.completed")?.event.payload.data,
      {
        pass: true,
        reason: "good",
        score: 0.9
      }
    );
    assert.deepEqual(
      events.find((entry) => entry.event.type === "turn.succeeded")?.event.payload.usage,
      {
        inputTokens: 11,
        outputTokens: 7,
        costUsd: 0.004
      }
    );
  } finally {
    await gateway.close();
  }
});

test("gateway bridge translates candidate text without inventing missing usage", async () => {
  const gateway = await startGateway((_request, response) => {
    sendJson(response, 200, {
      id: "completion-2",
      model: "openai/candidate",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "candidate answer" },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 3 }
    });
  });
  try {
    const response = await invokeBridge(gateway.origin, "token", command());
    assert.equal(response.status, 200);
    const events = await readEvents(response);
    assert.equal(
      events.find((entry) => entry.event.type === "assistant.text.delta")?.event.payload.delta,
      "candidate answer"
    );
    const terminal = events.find((entry) => entry.event.type === "turn.succeeded")?.event.payload;
    assert.deepEqual(terminal, {});
  } finally {
    await gateway.close();
  }
});

test("gateway bridge rejects auto before making an upstream request", async () => {
  let calls = 0;
  const gateway = await startGateway((_request, response) => {
    calls += 1;
    sendJson(response, 200, {});
  });
  try {
    const response = await invokeBridge(gateway.origin, "token", command({ model: "auto" }));
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    assert.deepEqual(await response.json(), {
      error: {
        code: "invalid_request",
        message: "model must be an explicit provider/model id."
      }
    });
  } finally {
    await gateway.close();
  }
});

test("gateway bridge accepts a RouteKit /v1 base without doubling the path", async () => {
  let requestUrl: string | undefined;
  const gateway = await startGateway((request, response) => {
    requestUrl = request.url;
    sendJson(response, 200, {
      model: "openai/candidate",
      choices: [{ message: { role: "assistant", content: "answer" } }]
    });
  });
  try {
    const response = await invokeBridge(`${gateway.origin}/v1`, "token", command());
    assert.equal(response.status, 200);
    assert.equal(requestUrl, "/v1/chat/completions");
  } finally {
    await gateway.close();
  }
});

test("gateway bridge redacts bearer credentials from upstream failures", async () => {
  const credential = "do-not-leak-this-token";
  const gateway = await startGateway((_request, response) => {
    sendJson(response, 503, { error: { message: `provider rejected ${credential}` } });
  });
  try {
    const response = await invokeBridge(gateway.origin, credential, command());
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.includes(credential), false);
    assert.deepEqual(JSON.parse(text), {
      error: {
        code: "gateway_failure",
        message: "RouteKit Eval gateway call failed."
      }
    });
  } finally {
    await gateway.close();
  }
});
