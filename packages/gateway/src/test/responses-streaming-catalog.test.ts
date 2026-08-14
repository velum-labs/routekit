import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { test } from "node:test";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import {
  attachReasoningSelection,
  attachResponsesReasoningMetadata,
  reasoningSelectionErrorOf,
  reasoningSelectionOf,
  responsesReasoningMetadataErrorOf,
  responsesReasoningMetadataOf
} from "../adapters/openai-chat-wire.js";
import {
  parseResponsesEncryptedContent,
  wrapResponsesEncryptedContent
} from "../adapters/openai-responses-wire.js";
import {
  chatToResponses,
  openAiSseToResponses,
  responsesToChat,
  responsesToolRegistry
} from "../adapters/responses.js";
import { type Backend, ModelRoutedBackend } from "../backend.js";
import { OpenAiBackend } from "../openai-backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { AnthropicBackend, CodexResponsesBackend } from "../provider-backends.js";
import { RoutingBackend } from "../router.js";
import type { ModelCatalogRelay, RequestRelay } from "../server.js";
import { startGateway } from "../server.js";
import { testProviderSource } from "./provider-source-fixture.js";
import {
  chatChunk,
  chatOnlyOpenAiBackend,
  codexAliasBackend,
  type Mock,
  PATCH,
  readAll,
  sendJson,
  sseStream,
  startMock,
  TOOL_SEARCH_DECL,
  WEB_SEARCH_DECL
} from "./responses-fixtures.js";

test("a mid-stream provider error event becomes response.failed with the upstream message", async () => {
  // The router surfaces a classified provider failure as an OpenAI-style
  // `data: {"error": {...}}` SSE event. The Responses translation must carry
  // that message to the consumer (codex shows it verbatim) instead of ending
  // the stream as a bare disconnect.
  const stream = openAiSseToResponses(
    sseStream(
      `data: ${JSON.stringify({
        error: {
          message:
            "openrouter call failed (unknown); see the server logs for the provider's message",
          type: "provider_error",
          code: "unknown"
        }
      })}\n\n`,
      "data: [DONE]\n\n"
    ),
    "grok-4"
  );
  const text = await new Response(stream).text();
  assert.ok(text.includes("event: response.failed"));
  assert.ok(text.includes("openrouter call failed (unknown)"));
  assert.ok(!text.includes("event: response.completed"));
});

test("translates a streamed Responses event sequence", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: chatOnlyOpenAiBackend(`${mock.url}/v1`, "local-model")
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", stream: true, input: "hello" })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("event: response.created"));
    assert.ok(text.includes("event: response.output_item.added"));
    assert.ok(text.includes("event: response.output_text.delta"));
    assert.ok(text.includes('"delta":"Hi"'));
    assert.ok(text.includes("event: response.completed"));
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("Codex catalog filters chat-only OpenRouter models and preserves reasoning summaries", async () => {
  const source = (sourceId: "openai" | "openrouter", wireShape: "openai-chat" | "openrouter") =>
    testProviderSource({
      sourceId,
      discoverModels: () =>
        Effect.succeed([
          {
            id: sourceId === "openai" ? "gpt-5.5" : "reasoning-model",
            ...(sourceId === "openrouter"
              ? {
                  metadata: {
                    architecture: {
                      inputModalities: ["text"],
                      outputModalities: ["text"]
                    },
                    supportedParameters: ["tools"],
                    provenance: "provider" as const
                  }
                }
              : {}),
            reasoning: {
              status: "supported" as const,
              efforts: [{ id: "high" }],
              wireShape,
              provenance: "provider" as const
            }
          },
          ...(sourceId === "openai" ? [{ id: "unknown-model" }] : [])
        ]),
      chat: () => Effect.succeed(Response.json({})),
      embeddings: () => Effect.succeed(Response.json({}))
    });
  const chatOnly = testProviderSource({
    sourceId: "openrouter" as const,
    discoverModels: () => Effect.succeed([{ id: "chat-only" }]),
    chat: () => Effect.succeed(Response.json({})),
    embeddings: () => Effect.succeed(Response.json({}))
  });
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {}, openrouter: {} },
        defaultModel: "openai/gpt-5.5"
      },
      sources: {
        openai: source("openai", "openai-chat"),
        openrouter: testProviderSource({
          sourceId: "openrouter",
          discoverModels: () =>
            Effect.all([
              chatOnly.discovery.discoverModels(),
              source("openrouter", "openrouter").discovery.discoverModels()
            ]).pipe(Effect.map(([chatModels, routed]) => [...chatModels, ...routed]))
        })
      }
    })
  );
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(response.status, 200);
    const catalog = (await response.json()) as {
      data: Array<{ id: string }>;
      models: Array<{ slug: string; supports_reasoning_summaries: boolean }>;
    };
    assert.deepEqual(
      catalog.data.map((model) => model.id),
      [
        "openai/gpt-5.5",
        "openai/unknown-model",
        "openrouter/chat-only",
        "openrouter/reasoning-model"
      ]
    );
    assert.deepEqual(
      catalog.models.map((model) => [model.slug, model.supports_reasoning_summaries]),
      [["openrouter/reasoning-model", true]]
    );
  } finally {
    await gateway.close();
  }
});

test("Codex picker aliases use the canonical catalog and pooled native relay", async () => {
  const sourceCalls: string[] = [];
  const sourceBodies: Array<Record<string, unknown>> = [];
  const source = (sourceId: "codex" | "claude-code") =>
    testProviderSource({
      sourceId,
      discoverModels: () =>
        Effect.succeed([
          {
            id: sourceId === "codex" ? "gpt-5.5" : "claude-sonnet-4-6",
            metadata: {
              architecture: {
                inputModalities: ["text"],
                outputModalities: ["text"]
              },
              supportedParameters: ["tools", "tool_choice"],
              provenance: "route" as const
            }
          }
        ]),
      chat: (body: unknown) => {
        const request = body as Record<string, unknown> & { model: string };
        sourceCalls.push(request.model);
        sourceBodies.push(request);
        return Effect.succeed(
          Response.json({
            id: "chatcmpl_cross_provider",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "CROSS_PROVIDER_OK" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        );
      },
      embeddings: () => Effect.succeed(Response.json({}))
    });
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { codex: {}, "claude-code": {} },
        defaultModel: "codex/gpt-5.5"
      },
      sources: {
        codex: source("codex"),
        "claude-code": source("claude-code")
      }
    })
  );
  const relayedBodies: Array<Record<string, unknown>> = [];
  const requestRelay: RequestRelay = {
    kind: "request",
    dialect: "codex",
    shouldRelay: () => false,
    relay: async (_headers, body) => {
      relayedBodies.push(body as Record<string, unknown>);
      return Response.json({
        id: "resp_native",
        object: "response",
        status: "completed",
        model: (body as { model: string }).model,
        output: [
          {
            type: "reasoning",
            id: "reasoning_native",
            encrypted_content: "raw-codex-response"
          }
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
  const catalogRelay: ModelCatalogRelay = {
    kind: "merged-models",
    dialect: "codex",
    mergedCatalog: async () => ({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Native Codex model",
          visibility: "list",
          priority: 7
        }
      ],
      etag: 'W/"upstream-catalog"'
    }),
    mergeDataIds: (data) => data
  };
  const gateway = await startGateway({
    backend,
    providerRelays: { codex: { request: requestRelay, catalog: catalogRelay } }
  });
  try {
    const catalogResponse = await fetch(`${gateway.url()}/v1/models?client_version=1.0.0`);
    assert.equal(
      catalogResponse.headers.get("etag"),
      null,
      "a projected managed catalog must not reuse the upstream ETag"
    );
    const catalog = (await catalogResponse.json()) as {
      default_model: string;
      data: Array<{ id: string }>;
      models: Array<{ slug: string; display_name: string }>;
    };
    assert.equal(catalog.default_model, "codex/gpt-5.5");
    assert.deepEqual(
      catalog.data.map((model) => model.id),
      ["codex/gpt-5.5", "claude-code/claude-sonnet-4-6"]
    );
    assert.deepEqual(
      catalog.models.map(({ slug, display_name }) => [slug, display_name]),
      [
        ["gpt-5.5", "GPT-5.5"],
        ["claude-code/claude-sonnet-4-6", "claude-code/claude-sonnet-4-6"]
      ]
    );

    const matching = wrapResponsesEncryptedContent("raw-codex-request", {
      provider: "codex",
      nativeModel: "gpt-5.5"
    });
    const foreignEncrypted = wrapResponsesEncryptedContent("raw-foreign-request", {
      provider: "openai-responses",
      nativeModel: "gpt-5.5"
    });
    for (const model of ["gpt-5.5", "codex/gpt-5.5"]) {
      const response = await fetch(`${gateway.url()}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: "You are Codex, a coding agent based on GPT-5.",
          input: [
            { type: "reasoning", encrypted_content: matching },
            { type: "reasoning", encrypted_content: foreignEncrypted },
            { type: "reasoning", encrypted_content: "legacy-raw-request" },
            { type: "message", role: "user", content: "hi" }
          ],
          store: false,
          reasoning: { effort: "high" }
        })
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        model: string;
        output: Array<{ encrypted_content?: string }>;
      };
      assert.equal(payload.model, "gpt-5.5");
      assert.deepEqual(parseResponsesEncryptedContent(payload.output[0]?.encrypted_content), {
        owner: { provider: "codex", nativeModel: "gpt-5.5" },
        ciphertext: "raw-codex-response"
      });
    }
    assert.deepEqual(
      relayedBodies.map((body) => body.model),
      ["gpt-5.5", "gpt-5.5"]
    );
    assert.ok(relayedBodies.every((body) => body.store === false));
    assert.ok(
      relayedBodies.every(
        (body) => (body.reasoning as { effort?: string } | undefined)?.effort === "high"
      )
    );
    assert.ok(
      relayedBodies.every(
        (body) => body.instructions === "You are Codex, a coding agent based on GPT-5."
      ),
      "native Codex routes preserve the stock instructions verbatim"
    );
    assert.ok(
      relayedBodies.every((body) => {
        const input = body.input as Array<Record<string, unknown>>;
        return (
          input.length === 2 &&
          input[0]?.encrypted_content === "raw-codex-request" &&
          input[1]?.type === "message" &&
          !JSON.stringify(input).includes("rk1.") &&
          !JSON.stringify(input).includes("foreign") &&
          !JSON.stringify(input).includes("legacy")
        );
      }),
      "both aliases unwrap only reasoning owned by the native Codex route"
    );
    assert.deepEqual(sourceCalls, []);

    const foreign = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code/claude-sonnet-4-6",
        instructions: "You are Codex, a coding agent based on GPT-5.",
        input: "hi",
        reasoning: { effort: "none" }
      })
    });
    assert.equal(foreign.status, 200);
    assert.deepEqual(sourceCalls, ["claude-sonnet-4-6"]);
    assert.equal(sourceBodies[0]?.reasoning_effort, undefined);
    assert.deepEqual(reasoningSelectionOf(sourceBodies[0]), { mode: "auto" });
    assert.ok(
      !JSON.stringify(sourceBodies[0]?.messages).includes("based on GPT-5"),
      "a stale startup-model identity must not cross into a foreign provider"
    );

    const unknown = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-not-real", input: "hi" })
    });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown model/);
    assert.deepEqual(
      relayedBodies.map((body) => body.model),
      ["gpt-5.5", "gpt-5.5"]
    );
  } finally {
    await gateway.close();
  }
});

test("Codex native picker alias routes through the catalog without a managed relay", async () => {
  const sourceCalls: string[] = [];
  const backend = await codexAliasBackend(sourceCalls);
  const gateway = await startGateway({ backend });
  try {
    const catalogResponse = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()) as {
      models: Array<{ slug: string }>;
    };
    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      ["matrix-codex"]
    );

    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "matrix-codex", input: "hi" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(sourceCalls, ["matrix-codex"]);

    const unknown = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-in-catalog", input: "hi" })
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(sourceCalls, ["matrix-codex"]);
  } finally {
    await gateway.close();
  }
});

test("Codex client relay still receives unknown native models after alias resolution", async () => {
  const sourceCalls: string[] = [];
  const backend = await codexAliasBackend(sourceCalls);
  const relayCalls: Array<Record<string, unknown>> = [];
  const relay: RequestRelay = {
    kind: "request",
    dialect: "codex",
    shouldRelay: () => true,
    relay: async (_headers, body) => {
      relayCalls.push(body as Record<string, unknown>);
      return Response.json({
        id: "resp_client_relay",
        object: "response",
        status: "completed",
        model: (body as { model: string }).model,
        output: [
          {
            type: "reasoning",
            id: "reasoning_client_relay",
            encrypted_content: "raw-client-relay-response"
          }
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
  const gateway = await startGateway({ backend, codexRelay: { request: relay } });
  try {
    const managed = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "matrix-codex", input: "hi" })
    });
    assert.equal(managed.status, 200);
    assert.deepEqual(sourceCalls, ["matrix-codex"]);
    assert.equal(relayCalls.length, 0);

    const matching = wrapResponsesEncryptedContent("raw-client-relay-request", {
      provider: "codex",
      nativeModel: "upstream-only"
    });
    const foreign = wrapResponsesEncryptedContent("raw-foreign-request", {
      provider: "codex",
      nativeModel: "different-model"
    });
    const relayed = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "upstream-only",
        input: [
          { type: "reasoning", encrypted_content: matching },
          { type: "reasoning", encrypted_content: foreign },
          { type: "reasoning", encrypted_content: "legacy-raw-request" },
          {
            type: "tool_search_call",
            id: "tsc_persisted",
            call_id: "call_search",
            status: "completed",
            execution: "client",
            arguments: { query: "verification" }
          },
          {
            type: "tool_search_output",
            call_id: "call_search",
            status: "completed",
            execution: "client",
            tools: []
          },
          { type: "message", role: "user", content: "hi" }
        ]
      })
    });
    assert.equal(relayed.status, 200);
    const payload = (await relayed.json()) as {
      output: Array<{ encrypted_content?: string }>;
    };
    assert.deepEqual(parseResponsesEncryptedContent(payload.output[0]?.encrypted_content), {
      owner: { provider: "codex", nativeModel: "upstream-only" },
      ciphertext: "raw-client-relay-response"
    });
    assert.deepEqual(sourceCalls, ["matrix-codex"]);
    assert.equal(relayCalls[0]?.model, "upstream-only");
    assert.deepEqual(relayCalls[0]?.input, [
      { type: "reasoning", encrypted_content: "raw-client-relay-request" },
      {
        type: "tool_search_call",
        id: "tsc_persisted",
        call_id: "call_search",
        status: "completed",
        execution: "client",
        arguments: { query: "verification" }
      },
      {
        type: "tool_search_output",
        call_id: "call_search",
        status: "completed",
        execution: "client",
        tools: []
      },
      { type: "message", role: "user", content: "hi" }
    ]);
    assert.ok(!JSON.stringify(relayCalls[0]).includes("rk1."));
  } finally {
    await gateway.close();
  }
});

test("Codex client relay owns streaming reasoning and preserves tool continuation", async () => {
  const sourceCalls: string[] = [];
  const backend = await codexAliasBackend(sourceCalls);
  let relayedBody: Record<string, unknown> | undefined;
  const relay: RequestRelay = {
    kind: "request",
    dialect: "codex",
    shouldRelay: () => true,
    relay: async (_headers, body) => {
      relayedBody = body as Record<string, unknown>;
      return new Response(
        sseStream(
          "event: response.output_item.added\n",
          'data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_',
          'content":"raw-stream-response"}}\n\n',
          "event: response.output_item.done\n",
          'data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"raw-stream-response"}}\n\n',
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"output":[{"type":"reasoning","encrypted_content":"raw-stream-response"}]}}\n\n',
          "data: [DONE]\n\n"
        ),
        { headers: { "content-type": "text/event-stream" } }
      );
    }
  };
  const gateway = await startGateway({ backend, codexRelay: { request: relay } });
  try {
    const matching = wrapResponsesEncryptedContent("raw-stream-request", {
      provider: "codex",
      nativeModel: "upstream-stream"
    });
    const toolItems = [
      { type: "function_call", call_id: "call_weather", name: "weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_weather", output: "24" }
    ];
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "upstream-stream",
        stream: true,
        input: [{ type: "reasoning", encrypted_content: matching }, ...toolItems],
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    const encrypted = [...stream.matchAll(/"encrypted_content":"([^"]+)"/g)].map((match) =>
      parseResponsesEncryptedContent(match[1])
    );
    assert.equal(encrypted.length, 3);
    for (const item of encrypted)
      assert.deepEqual(item, {
        owner: { provider: "codex", nativeModel: "upstream-stream" },
        ciphertext: "raw-stream-response"
      });
    assert.match(stream, /data: \[DONE\]\n\n$/);
    assert.deepEqual(relayedBody?.input, [
      { type: "reasoning", encrypted_content: "raw-stream-request" },
      ...toolItems
    ]);
    assert.ok(!JSON.stringify(relayedBody).includes("rk1."));
    assert.deepEqual(sourceCalls, []);
  } finally {
    await gateway.close();
  }
});
