import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect } from "effect";

import {
  makeOriRouteKitGatewayBridge,
  type OriRouteKitGatewayBridgeOptions,
  type OriRouteKitGatewayBridgeService
} from "../../src/library/ori-gateway-bridge.ts";

const PARENT_CREDENTIAL = "real-routekit-secret";
const AUTHOR_MODEL = "codex/gpt-5.5";
const JUDGE_MODEL = "claude-code/claude-opus-4-6";

interface RecordedRequest {
  readonly body: unknown;
  readonly headers: IncomingMessage["headers"];
  readonly method: string | undefined;
  readonly url: string | undefined;
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const startGateway = async () => {
  const calls: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const recorded = {
        body: await readBody(request),
        headers: request.headers,
        method: request.method,
        url: request.url
      };
      calls.push(recorded);
      if (request.headers.authorization !== `Bearer ${PARENT_CREDENTIAL}`) {
        sendJson(response, 401, { error: { message: "unauthorized" } });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [
            {
              id: AUTHOR_MODEL,
              object: "model",
              owned_by: "codex",
              created: 123,
              architecture: {
                modality: "text->text",
                input_modalities: ["text"],
                output_modalities: ["text"]
              },
              supported_parameters: ["tools", "tool_choice"]
            },
            {
              id: JUDGE_MODEL,
              object: "model",
              owned_by: "claude-code",
              supported_parameters: ["tools"]
            },
            {
              id: "openai/disallowed",
              object: "model",
              owned_by: "openai",
              pricing: { prompt: "0.00001" },
              benchmarks: {
                artificial_analysis: { intelligence_index: 99 }
              }
            }
          ]
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const model = (recorded.body as { model?: unknown } | undefined)?.model;
        sendJson(response, 200, {
          id: "chatcmpl-1",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "bridge answer" } }]
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/messages") {
        const model = (recorded.body as { model?: unknown } | undefined)?.model;
        sendJson(response, 200, {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "anthropic answer" }]
        });
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    calls,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
};

const bridgeOptions = (
  gatewayOrigin: string,
  overrides: Partial<OriRouteKitGatewayBridgeOptions> = {}
): OriRouteKitGatewayBridgeOptions => ({
  gatewayOrigin,
  bearerCredential: PARENT_CREDENTIAL,
  allowModel: (model) => model.startsWith("codex/") || model.startsWith("claude-code/"),
  authorModel: AUTHOR_MODEL,
  judgeModel: JUDGE_MODEL,
  attribution: { runId: "authoring-run-1", caseId: "case-7" },
  ...overrides
});

const withBridge = async <A>(
  options: OriRouteKitGatewayBridgeOptions,
  use: (bridge: OriRouteKitGatewayBridgeService) => Promise<A>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* makeOriRouteKitGatewayBridge(options);
        return yield* Effect.tryPromise(() => use(bridge));
      })
    ).pipe(Effect.provide(NodeHttpClient.layerUndici))
  );

const childHeaders = (bridge: OriRouteKitGatewayBridgeService) => ({
  authorization: `Bearer ${bridge.childCredential}`
});

test("Ori bridge isolates the parent token and authenticates every child route", async () => {
  const gateway = await startGateway();
  try {
    await withBridge(bridgeOptions(gateway.origin), async (bridge) => {
      assert.equal(bridge.hostname, "127.0.0.1");
      assert.match(bridge.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.notEqual(bridge.childCredential, PARENT_CREDENTIAL);
      assert.equal(JSON.stringify(bridge).includes(PARENT_CREDENTIAL), false);

      const missing = await fetch(`${bridge.origin}/v1/models`);
      const wrong = await fetch(`${bridge.origin}/v1/models`, {
        headers: { authorization: "Bearer wrong-token" }
      });
      const parent = await fetch(`${bridge.origin}/v1/models`, {
        headers: { authorization: `Bearer ${PARENT_CREDENTIAL}` }
      });
      const accepted = await fetch(`${bridge.origin}/v1/models`, {
        headers: childHeaders(bridge)
      });

      assert.equal(missing.status, 401);
      assert.equal(missing.headers.get("www-authenticate"), "Bearer");
      assert.equal(wrong.status, 401);
      assert.equal(parent.status, 401);
      assert.equal(accepted.status, 200);
    });

    assert.equal(gateway.calls[0]?.method, "GET");
    assert.equal(gateway.calls[0]?.headers.authorization, `Bearer ${PARENT_CREDENTIAL}`);
    assert.equal(
      gateway.calls.some((call) => call.headers.authorization?.includes("rk_ori_") === true),
      false
    );
  } finally {
    await gateway.close();
  }
});

test("Ori bridge exposes filtered Ori-compatible catalog and endpoint shapes", async () => {
  const gateway = await startGateway();
  try {
    await withBridge(bridgeOptions(gateway.origin), async (bridge) => {
      assert.deepEqual(bridge.models, [AUTHOR_MODEL, JUDGE_MODEL]);
      assert.equal(bridge.authorModel, AUTHOR_MODEL);
      assert.equal(bridge.judgeModel, JUDGE_MODEL);

      const catalogResponse = await fetch(`${bridge.origin}/v1/models?sort=top-weekly`, {
        headers: childHeaders(bridge)
      });
      assert.equal(catalogResponse.status, 200);
      const catalog = (await catalogResponse.json()) as {
        data: Array<Record<string, unknown>>;
      };
      assert.deepEqual(
        catalog.data.map((entry) => entry.id),
        [AUTHOR_MODEL, JUDGE_MODEL]
      );
      assert.deepEqual(catalog.data[0]?.architecture, {
        modality: "text->text",
        input_modalities: ["text"],
        output_modalities: ["text"]
      });
      assert.equal("pricing" in (catalog.data[0] ?? {}), false);
      assert.equal("benchmarks" in (catalog.data[0] ?? {}), false);

      const endpointResponse = await fetch(`${bridge.origin}/v1/models/codex/gpt-5.5/endpoints`, {
        headers: childHeaders(bridge)
      });
      assert.equal(endpointResponse.status, 200);
      assert.deepEqual(await endpointResponse.json(), {
        data: {
          endpoints: [
            {
              provider_name: "codex",
              supported_parameters: ["tools", "tool_choice"]
            }
          ]
        }
      });

      const disallowed = await fetch(`${bridge.origin}/v1/models/openai/disallowed/endpoints`, {
        headers: childHeaders(bridge)
      });
      assert.equal(disallowed.status, 404);
    });
  } finally {
    await gateway.close();
  }
});

test("Ori bridge restricts inference models and adds parent-controlled eval headers", async () => {
  const gateway = await startGateway();
  try {
    await withBridge(
      bridgeOptions(gateway.origin, {
        allowModel: [AUTHOR_MODEL, JUDGE_MODEL]
      }),
      async (bridge) => {
        const invoke = (model: string) =>
          fetch(`${bridge.origin}/v1/chat/completions`, {
            method: "POST",
            headers: {
              ...childHeaders(bridge),
              "content-type": "application/json",
              "x-routekit-eval-attribution": JSON.stringify({ role: "attacker" })
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "Answer this" }],
              stream: false
            })
          });

        for (const model of ["auto", "router", "default", "openai/disallowed"]) {
          const rejected = await invoke(model);
          assert.equal(rejected.status, 400);
        }

        const author = await invoke(AUTHOR_MODEL);
        assert.equal(author.status, 200);
        assert.deepEqual(await author.json(), {
          id: "chatcmpl-1",
          model: AUTHOR_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "bridge answer" } }]
        });

        const judge = await invoke(JUDGE_MODEL);
        assert.equal(judge.status, 200);
        await judge.arrayBuffer();
      }
    );

    const inference = gateway.calls.filter((call) => call.method === "POST");
    assert.equal(inference.length, 2);
    assert.ok(
      inference.every((call) => call.headers.authorization === `Bearer ${PARENT_CREDENTIAL}`)
    );
    assert.ok(inference.every((call) => call.headers["x-routekit-eval-policy-bypass"] === "1"));
    assert.deepEqual(
      inference.map((call) => JSON.parse(String(call.headers["x-routekit-eval-attribution"]))),
      [
        {
          purpose: "eval",
          role: "author",
          runId: "authoring-run-1",
          caseId: "case-7"
        },
        {
          purpose: "eval",
          role: "judge",
          runId: "authoring-run-1",
          caseId: "case-7"
        }
      ]
    );
    assert.ok(
      inference.every(
        (call) => call.headers["x-routekit-eval-attribution"] !== '{"role":"attacker"}'
      )
    );
  } finally {
    await gateway.close();
  }
});

test("Ori bridge proxies Anthropic messages with x-api-key child auth", async () => {
  const gateway = await startGateway();
  try {
    await withBridge(bridgeOptions(gateway.origin), async (bridge) => {
      const accepted = await fetch(`${bridge.origin}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": bridge.childCredential,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          max_tokens: 32,
          context_management: { edits: [] },
          messages: [{ role: "user", content: "Answer this" }]
        })
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: JUDGE_MODEL,
        content: [{ type: "text", text: "anthropic answer" }]
      });
    });

    const messages = gateway.calls.filter((call) => call.url === "/v1/messages");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.headers.authorization, `Bearer ${PARENT_CREDENTIAL}`);
    assert.equal(messages[0]?.headers["anthropic-version"], "2023-06-01");
    assert.equal(messages[0]?.headers["x-routekit-eval-policy-bypass"], "1");
    assert.equal(
      messages[0]?.body !== null &&
        typeof messages[0]?.body === "object" &&
        "context_management" in (messages[0]?.body as object),
      false
    );
    assert.deepEqual(JSON.parse(String(messages[0]?.headers["x-routekit-eval-attribution"])), {
      purpose: "eval",
      role: "judge",
      runId: "authoring-run-1",
      caseId: "case-7"
    });
  } finally {
    await gateway.close();
  }
});

test("Ori bridge strips unknown OpenAI chat-completion fields", async () => {
  const gateway = await startGateway();
  try {
    await withBridge(bridgeOptions(gateway.origin), async (bridge) => {
      const accepted = await fetch(`${bridge.origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          ...childHeaders(bridge),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: AUTHOR_MODEL,
          messages: [{ role: "user", content: "Answer this" }],
          reasoning: { effort: "high" },
          reasoning_effort: "high",
          max_tokens: 32,
          tools: [{ type: "function", function: { name: "read" } }],
          stream: false
        })
      });
      assert.equal(accepted.status, 200);
    });
    const completions = gateway.calls.filter((call) => call.url === "/v1/chat/completions");
    assert.equal(completions.length, 1);
    const body = completions[0]?.body as Record<string, unknown>;
    assert.equal("reasoning" in body, false);
    assert.equal("max_tokens" in body, false);
    assert.equal(body.max_completion_tokens, 32);
    assert.equal(body.reasoning_effort, "none");
  } finally {
    await gateway.close();
  }
});
