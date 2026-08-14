import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { test } from "node:test";
import { RouteKitFailure, runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import {
  attachReasoningSelection,
  attachResponsesReasoningMetadata,
  reasoningSelectionErrorOf,
  reasoningSelectionOf,
  responsesReasoningItem,
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
import {
  type Backend,
  borrowedBackendPorts,
  ModelRoutedBackend,
  staticBackendModelPort
} from "../backend.js";
import { OpenAiBackend } from "../openai-backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { AnthropicBackend, CodexResponsesBackend } from "../provider-backends.js";
import { RoutingBackend } from "../router.js";
import { startGateway } from "../server.js";
import { asTransport } from "./provider-backends-fixtures.js";
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

test("Responses accepts identical native and envelope effort controls", () => {
  const chat = responsesToChat(
    {
      input: "hello",
      reasoning: { effort: "high" },
      x_routekit: { version: 1, selection: { mode: "effort", effort: "high" } }
    },
    "model"
  );
  assert.deepEqual(reasoningSelectionOf(chat), { mode: "effort", effort: "high" });
});

test("GPT-5.6 API routes Responses tools and reasoning without Chat translation", async () => {
  let upstreamPath: string | undefined;
  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamModelCallId: string | undefined;
  const upstream = createServer((req, res) => {
    void (async () => {
      upstreamPath = req.url;
      upstreamModelCallId =
        typeof req.headers[MODEL_CALL_ID_HEADER] === "string"
          ? req.headers[MODEL_CALL_ID_HEADER]
          : undefined;
      upstreamBody = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
      sendJson(res, 200, {
        id: "resp_native",
        object: "response",
        status: "completed",
        model: upstreamBody.model,
        output: [
          {
            id: "msg_native",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "NATIVE_OK", annotations: [] }]
          }
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
      });
    })();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const openai = new OpenAiBackend({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key"
  });
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/gpt-5.6-sol"
      },
      sources: {
        openai: testProviderSource({
          sourceId: "openai",
          discoverModels: () => Effect.succeed([{ id: "gpt-5.6-sol" }]),
          chat: () => {
            throw new RouteKitFailure({
              message: "Chat Completions must not be used for GPT-5.6 Responses"
            });
          },
          responses: {
            supports: () => openai.supportsResponses(),
            execute: (body, signal, options) => openai.responses(body, signal, options)
          },
          embeddings: () => Effect.succeed(Response.json({}))
        })
      }
    })
  );
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.6-sol",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Use the tool." }]
          }
        ],
        reasoning: { effort: "high" },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Look up a value",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false
            },
            strict: true
          }
        ],
        x_routekit: {
          version: 1,
          selection: { mode: "effort", effort: "high" }
        }
      })
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamPath, "/v1/responses");
    assert.equal(upstreamBody?.model, "gpt-5.6-sol");
    assert.deepEqual(upstreamBody?.reasoning, { effort: "high" });
    assert.equal((upstreamBody?.tools as unknown[])?.length, 1);
    assert.equal(Object.hasOwn(upstreamBody ?? {}, "x_routekit"), false);
    assert.ok(upstreamModelCallId);
    assert.equal(
      ((await response.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> })
        .output?.[0]?.content?.[0]?.text,
      "NATIVE_OK"
    );
    assert.deepEqual(backend.modelInfo("openai/gpt-5.6-sol")?.reasoning, {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultEffort: "medium",
      wireShape: "openai-responses",
      provenance: "builtin"
    });
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("OpenAI API keeps non-reasoning models on native Responses", async () => {
  let upstreamPath: string | undefined;
  let upstreamBody: Record<string, unknown> | undefined;
  const upstream = createServer((req, res) => {
    void (async () => {
      upstreamPath = req.url;
      upstreamBody = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
      sendJson(res, 200, {
        id: "resp_general",
        object: "response",
        status: "completed",
        model: upstreamBody.model,
        output: []
      });
    })();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const openai = new OpenAiBackend({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key"
  });
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/gpt-4.1"
      },
      sources: {
        openai: testProviderSource({
          sourceId: "openai",
          discoverModels: () => Effect.succeed([{ id: "gpt-4.1" }]),
          chat: () => {
            throw new RouteKitFailure({
              message: "Chat Completions must not be used for OpenAI Responses"
            });
          },
          responses: {
            supports: () => openai.supportsResponses(),
            execute: (body, signal, options) => openai.responses(body, signal, options)
          },
          embeddings: () => Effect.succeed(Response.json({}))
        })
      }
    })
  );
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4.1",
        input: "Use the tool.",
        previous_response_id: "resp_previous",
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Look up a value",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false
            },
            strict: true
          }
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamPath, "/v1/responses");
    assert.equal(upstreamBody?.model, "gpt-4.1");
    assert.equal(upstreamBody?.previous_response_id, "resp_previous");
    assert.equal((upstreamBody?.tools as unknown[])?.length, 1);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("serves a Responses request carrying reasoning: null end to end", async () => {
  // The member capture gateway path: codex exec -> /v1/responses with
  // `reasoning: null` -> chat completion upstream. Must be a 200, never a 502.
  const mock = await startMock();
  const gateway = await startGateway({
    backend: chatOnlyOpenAiBackend(`${mock.url}/v1`, "grok-4")
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4",
        input: "say OK",
        reasoning: null,
        include: [],
        store: false,
        stream: false
      })
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      status: string;
      output: Array<{ type: string; content?: Array<{ text?: string }> }>;
    };
    assert.equal(json.status, "completed");
    assert.equal(json.output[0]?.content?.[0]?.text, "Final answer");
    assert.equal(mock.lastChatBody()?.reasoning_effort, undefined);
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("Responses routes discovered Claude efforts to adaptive Anthropic egress", async () => {
  const requests: Request[] = [];
  const anthropic = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "unused",
    transport: asTransport(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        id: "msg_fable",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "FABLE_OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      });
    })
  });
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { "claude-code": {} },
        defaultModel: "claude-code/claude-fable-5"
      },
      sources: {
        "claude-code": testProviderSource({
          sourceId: "claude-code",
          discoverModels: () =>
            Effect.succeed([
              {
                id: "claude-fable-5",
                reasoning: {
                  status: "supported",
                  efforts: [{ id: "low" }, { id: "high" }],
                  budget: { minTokens: 1_024 },
                  adaptive: true,
                  wireShape: "anthropic",
                  provenance: "provider"
                }
              }
            ]),
          chat: (body, signal, options) => anthropic.chat(body, signal, options),
          embeddings: () => Effect.succeed(Response.json({}))
        })
      }
    })
  );
  const gateway = await startGateway({ backend });
  try {
    const supported = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code/claude-fable-5",
        input: "hi",
        max_output_tokens: 64,
        reasoning: { effort: "high" }
      })
    });
    assert.equal(supported.status, 200);
    const outbound = (await requests[0]?.json()) as {
      thinking?: unknown;
      output_config?: unknown;
    };
    assert.deepEqual(outbound.thinking, { type: "adaptive" });
    assert.deepEqual(outbound.output_config, { effort: "high" });

    const unsupported = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code/claude-fable-5",
        input: "hi",
        reasoning: { effort: "max" }
      })
    });
    assert.equal(unsupported.status, 400);
    assert.equal(
      ((await unsupported.json()) as { error?: { message?: string } }).error?.message,
      'reasoning effort "max" is not supported by model "claude-code/claude-fable-5"'
    );
    assert.equal(requests.length, 1);
  } finally {
    await gateway.close();
  }
});

test("serves a Responses request with null optional fields end to end", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: chatOnlyOpenAiBackend(`${mock.url}/v1`, "local-model")
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "route-primary",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }
        ],
        reasoning: null,
        text: null,
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: []
      })
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { object: string; status: string };
    assert.equal(json.object, "response");
    assert.equal(json.status, "completed");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("serves a non-streaming Responses object end to end", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: chatOnlyOpenAiBackend(`${mock.url}/v1`, "local-model")
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", input: "hello" })
    });
    assert.equal(response.status, 200);
    assert.equal(mock.lastModelCallId(), response.headers.get(MODEL_CALL_ID_HEADER));
    const json = (await response.json()) as {
      object: string;
      status: string;
      output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(json.object, "response");
    assert.equal(json.status, "completed");
    assert.equal(json.output[0]?.type, "message");
    assert.equal(json.output[0]?.content?.[0]?.text, "Final answer");
    assert.equal(json.usage.output_tokens, 2);
    assert.equal(mock.lastChatBody()?.model, "local-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("reasoning and Responses metadata attachments preserve each other", () => {
  const metadata = {
    items: [
      {
        type: "reasoning" as const,
        id: "rs_encrypted",
        encrypted_content: "opaque-ciphertext"
      }
    ],
    includeEncryptedContent: true
  };
  for (const order of ["responses-first", "selection-first"] as const) {
    const target: Record<PropertyKey, unknown> = {
      x_routekit: { version: 1, future_extension: { retained: true } }
    };
    if (order === "responses-first") {
      attachResponsesReasoningMetadata(target, metadata);
      attachReasoningSelection(target, { mode: "effort", effort: "high" });
    } else {
      attachReasoningSelection(target, { mode: "effort", effort: "high" });
      attachResponsesReasoningMetadata(target, metadata);
    }
    assert.deepEqual(
      responsesReasoningMetadataOf(target)?.items.map(responsesReasoningItem),
      metadata.items
    );
    assert.equal(responsesReasoningMetadataOf(target)?.includeEncryptedContent, true);
    assert.deepEqual(reasoningSelectionOf(target), { mode: "effort", effort: "high" });
    assert.deepEqual((target.x_routekit as Record<string, unknown>).future_extension, {
      retained: true
    });
    assert.deepEqual((target.x_routekit as Record<string, unknown>).responses, metadata);
  }
});

test("Responses reasoning metadata validation fails closed and preserves valid items", async () => {
  const malformed = [
    [{ items: [null], includeEncryptedContent: true }, /items\[0\] must be an object/],
    [{ items: [3], includeEncryptedContent: true }, /items\[0\] must be an object/],
    [
      { items: [{ type: "future", encrypted_content: "x" }], includeEncryptedContent: true },
      /type must be "reasoning"/
    ],
    [
      { items: [{ type: "reasoning" }], includeEncryptedContent: true },
      /encrypted_content must be a non-empty string/
    ],
    [
      { items: [{ type: "reasoning", encrypted_content: "" }], includeEncryptedContent: true },
      /encrypted_content must be a non-empty string/
    ],
    [
      {
        items: [{ type: "reasoning", encrypted_content: "x", summary: undefined }],
        includeEncryptedContent: true
      },
      /summary must be JSON-compatible/
    ],
    [
      {
        items: [{ type: "reasoning", encrypted_content: "x", content: () => 1 }],
        includeEncryptedContent: true
      },
      /content must be JSON-compatible/
    ],
    [{ items: [], includeEncryptedContent: "yes" }, /includeEncryptedContent must be a boolean/]
  ] as const;
  for (const [metadata, expected] of malformed) {
    const target = { x_routekit: { version: 1, responses: metadata } };
    assert.match(responsesReasoningMetadataErrorOf(target) ?? "", expected);
    assert.equal(responsesReasoningMetadataOf(target), undefined);
  }
  const valid = {
    items: [
      {
        type: "reasoning" as const,
        id: "rs_a",
        encrypted_content: "a",
        summary: [],
        future: { ok: true }
      },
      { type: "reasoning" as const, encrypted_content: "b", content: null }
    ],
    includeEncryptedContent: true
  };
  assert.equal(
    responsesReasoningMetadataErrorOf({ x_routekit: { version: 1, responses: valid } }),
    undefined
  );
  const canonical = responsesReasoningMetadataOf({
    x_routekit: { version: 1, responses: valid }
  });
  assert.deepEqual(canonical?.items.map(responsesReasoningItem), [
    {
      type: "reasoning",
      id: "rs_a",
      encrypted_content: "a",
      summary: []
    },
    { type: "reasoning", encrypted_content: "b", content: null }
  ]);
  assert.equal(canonical?.includeEncryptedContent, true);

  let calls = 0;
  const backend: import("../backend.js").Backend = {
    defaultModel: "m",
    ports: borrowedBackendPorts("m"),
    chat: () => {
      calls += 1;
      return Effect.succeed(Response.json({}));
    },
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        input: "hello",
        x_routekit: { version: 1, responses: { items: [null], includeEncryptedContent: true } }
      })
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code: string; param: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.equal(error.error.param, "x_routekit.responses");
    assert.equal(calls, 0);
  } finally {
    await gateway.close();
  }
});

test("responsesToChat attaches encrypted reasoning to following assistant text and calls", async () => {
  const encrypted = wrapResponsesEncryptedContent("opaque-ciphertext", {
    provider: "codex",
    nativeModel: "codex-model"
  });
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "inspect" },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "private summary" }],
          content: null,
          encrypted_content: encrypted
        },
        { type: "message", role: "assistant", content: "I will inspect." },
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" }
      ],
      include: ["reasoning.encrypted_content"]
    },
    "codex-model",
    { destinationWireShape: "openai-responses" }
  );
  const messages = chat.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3, "reasoning must not create a phantom assistant message");
  const assistant = messages[1];
  assert.equal(assistant?.content, "I will inspect.");
  assert.equal((assistant?.tool_calls as unknown[]).length, 1);
  assert.deepEqual(
    responsesReasoningMetadataOf(assistant)?.items.map((item) => responsesReasoningItem(item)?.id),
    ["rs_1"]
  );

  let request: Record<string, unknown> | undefined;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://codex.test",
    apiKey: "unused",
    defaultModel: "codex-model",
    transport: asTransport(async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ output: [] });
    })
  });
  await runRouteKitEffect(backend.chat(chat));
  assert.deepEqual(
    (request?.input as Array<Record<string, unknown>>).map((item) => item.type ?? item.role),
    ["user", "reasoning", "assistant", "function_call", "function_call_output"]
  );
});

test("responsesToChat uses one tool carrier for reasoning followed by calls", () => {
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "inspect" },
        { type: "reasoning", id: "rs_tool", encrypted_content: "opaque-tool" },
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" }
      ]
    },
    "codex-model",
    { destinationWireShape: "openai-responses" }
  );
  const messages = chat.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.content, null);
  assert.equal((messages[1]?.tool_calls as unknown[]).length, 1);
  assert.deepEqual(
    responsesReasoningMetadataOf(messages[1])?.items.map(
      (item) => responsesReasoningItem(item)?.id
    ),
    ["rs_tool"]
  );
});

test("responsesToChat attaches reasoning forward, never to a prior assistant", () => {
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "first" },
        { type: "message", role: "assistant", content: "previous" },
        { type: "reasoning", id: "rs_next", encrypted_content: "opaque-next" },
        { type: "message", role: "assistant", content: "next" }
      ]
    },
    "codex-model",
    { destinationWireShape: "openai-responses" }
  );
  const messages = chat.messages as Array<Record<string, unknown>>;
  assert.equal(responsesReasoningMetadataOf(messages[1]), undefined);
  assert.deepEqual(
    responsesReasoningMetadataOf(messages[2])?.items.map(
      (item) => responsesReasoningItem(item)?.id
    ),
    ["rs_next"]
  );
});

test("responsesToChat preserves multiple reasoning items in order", () => {
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "continue" },
        { type: "reasoning", id: "rs_a", encrypted_content: "opaque-a" },
        { type: "reasoning", id: "rs_b", encrypted_content: "opaque-b" },
        { type: "message", role: "assistant", content: "done" }
      ]
    },
    "codex-model",
    { destinationWireShape: "openai-responses" }
  );
  const assistant = (chat.messages as Array<Record<string, unknown>>)[1];
  assert.deepEqual(
    responsesReasoningMetadataOf(assistant)?.items.map((item) => responsesReasoningItem(item)?.id),
    ["rs_a", "rs_b"]
  );
});

test("responsesToChat rejects orphan or boundary-crossing encrypted reasoning", async () => {
  for (const input of [
    [
      { type: "message", role: "user", content: "continue" },
      { type: "reasoning", encrypted_content: "orphan" }
    ],
    [
      { type: "message", role: "user", content: "continue" },
      { type: "reasoning", encrypted_content: "crossing" },
      { type: "message", role: "user", content: "boundary" }
    ]
  ]) {
    assert.throws(
      () => responsesToChat({ input }, "codex-model", { destinationWireShape: "openai-responses" }),
      /encrypted reasoning must be followed by an assistant message or tool call/
    );
  }

  let calls = 0;
  const backend: import("../backend.js").Backend = {
    defaultModel: "codex-model",
    ports: borrowedBackendPorts("codex-model"),
    chat: () => {
      calls += 1;
      return Effect.succeed(Response.json({}));
    },
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  backend.ports = {
    models: staticBackendModelPort(backend.defaultModel, {
      reasoningWireShape: "openai-responses"
    }),
    responses: { kind: "unsupported" },
    lifecycle: { kind: "borrowed" }
  };
  const gateway = await startGateway({ backend });
  try {
    const orphan = wrapResponsesEncryptedContent("orphan", {
      provider: "codex",
      nativeModel: "codex-model"
    });
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex-model",
        input: [{ type: "reasoning", encrypted_content: orphan }]
      })
    });
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "invalid_encrypted_reasoning_order"
    );
    assert.equal(calls, 0);
  } finally {
    await gateway.close();
  }
});

test("responsesToChat associates encrypted reasoning with web search context", async () => {
  for (const trailingMessage of [false, true]) {
    const encrypted = wrapResponsesEncryptedContent("opaque-search", {
      provider: "codex",
      nativeModel: "codex-model"
    });
    const input: import("../adapters/responses.js").ResponsesInputItem[] = [
      { type: "message", role: "user", content: "search" },
      { type: "reasoning", id: "rs_search", encrypted_content: encrypted },
      { type: "web_search_call", id: "ws_1", status: "completed", action: { query: "routekit" } }
    ];
    if (trailingMessage) input.push({ type: "message", role: "assistant", content: "answer" });
    const chat = responsesToChat({ input }, "codex-model", {
      destinationWireShape: "openai-responses"
    });
    const messages = chat.messages as Array<Record<string, unknown>>;
    const searchCarrier = messages[1];
    assert.match(String(searchCarrier?.content), /searched the web/);
    assert.equal(String(searchCarrier?.content).includes("opaque-search"), false);
    assert.deepEqual(
      responsesReasoningMetadataOf(searchCarrier)?.items.map(
        (item) => responsesReasoningItem(item)?.id
      ),
      ["rs_search"]
    );

    let request: Record<string, unknown> | undefined;
    const backend = new CodexResponsesBackend({
      baseUrl: "https://codex.test",
      apiKey: "unused",
      defaultModel: "codex-model",
      transport: asTransport(async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ output: [] });
      })
    });
    await runRouteKitEffect(backend.chat(chat));
    const outbound = request?.input as Array<Record<string, unknown>>;
    assert.deepEqual(
      outbound.slice(0, 3).map((item) => item.type ?? item.role),
      ["user", "reasoning", "assistant"]
    );
    assert.equal(JSON.stringify(outbound).includes("opaque-search"), true);
  }
});

test("Responses forwards encrypted reasoning through a compound RouteKit envelope", async () => {
  const encrypted = wrapResponsesEncryptedContent("opaque-compound", {
    provider: "codex",
    nativeModel: "codex-model"
  });
  let forwarded: Record<string, unknown> | undefined;
  const backend: import("../backend.js").Backend = {
    defaultModel: "fusion-mini",
    ports: borrowedBackendPorts("fusion-mini"),
    chat: (body) => {
      forwarded = body as Record<string, unknown>;
      return Effect.succeed(
        Response.json({
          choices: [
            { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }
          ]
        })
      );
    },
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  backend.ports = {
    models: staticBackendModelPort(backend.defaultModel, {
      reasoningWireShape: "routekit-envelope"
    }),
    responses: { kind: "unsupported" },
    lifecycle: { kind: "borrowed" }
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-mini",
        input: [
          { role: "user", content: "continue" },
          { type: "reasoning", id: "rs_compound", encrypted_content: encrypted },
          { type: "message", role: "assistant", content: "continuing" }
        ],
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(responsesReasoningMetadataOf(forwarded), {
      items: [],
      includeEncryptedContent: true
    });
    const assistant = (forwarded?.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === "assistant"
    );
    assert.deepEqual(
      responsesReasoningMetadataOf(assistant)?.items.map(
        (item) => responsesReasoningItem(item)?.id
      ),
      ["rs_compound"]
    );
    assert.equal(String(assistant?.content).includes("opaque-compound"), false);
  } finally {
    await gateway.close();
  }
});

test("Responses follows ModelRoutedBackend reasoning wire capability", async () => {
  let codexCalls = 0;
  let codexBody: Record<string, unknown> | undefined;
  const codex = new CodexResponsesBackend({
    baseUrl: "https://codex.test",
    apiKey: "x",
    defaultModel: "codex-native",
    transport: asTransport(async (_url, init) => {
      codexCalls += 1;
      codexBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({
        id: "resp",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }
        ],
        usage: {}
      });
    })
  });
  let primaryCalls = 0;
  const primary: import("../backend.js").Backend = {
    defaultModel: "primary-model",
    ports: borrowedBackendPorts("primary-model"),
    chat: () => {
      primaryCalls += 1;
      return Effect.succeed(Response.json({ choices: [] }));
    },
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  primary.ports = {
    models: staticBackendModelPort(primary.defaultModel, {
      reasoningWireShape: "openai-chat"
    }),
    responses: { kind: "unsupported" },
    lifecycle: { kind: "borrowed" }
  };
  const backend = new ModelRoutedBackend({
    routedModelIds: ["codex-model"],
    routed: codex,
    primary
  });
  const gateway = await startGateway({ backend });
  const encrypted = wrapResponsesEncryptedContent("opaque-routed", {
    provider: "codex",
    nativeModel: "codex-model"
  });
  const input = [
    { role: "user", content: "continue" },
    { type: "reasoning", id: "rs_routed", encrypted_content: encrypted },
    { type: "message", role: "assistant", content: "prior" }
  ];
  try {
    const routed = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex-model",
        input,
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(routed.status, 200, await routed.text());
    assert.equal(codexCalls, 1);
    assert.equal(primaryCalls, 0);
    assert.equal(JSON.stringify(codexBody).includes("opaque-routed"), true);
    assert.deepEqual(codexBody?.include, ["reasoning.encrypted_content"]);

    const incompatible = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "primary-model",
        input,
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(incompatible.status, 200, await incompatible.text());
    assert.equal(primaryCalls, 1);

    assert.equal(backend.ports.models.reasoningWireShape("unknown-model"), "openai-chat");
    const unknownPrimary: import("../backend.js").Backend = {
      defaultModel: undefined,
      ports: borrowedBackendPorts(undefined),
      chat: () => Effect.succeed(Response.json({})),
      models: () => Effect.succeed(Response.json({})),
      embeddings: () => Effect.succeed(Response.json({}))
    };
    const conservative = new ModelRoutedBackend({
      routedModelIds: ["codex-model"],
      routed: codex,
      primary: unknownPrimary
    });
    assert.equal(conservative.ports.models.reasoningWireShape("unknown-model"), undefined);
  } finally {
    await gateway.close();
  }
});

test("native Responses swaps isolate provider reasoning and restore it on A to B to A", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const routes = {
    "provider-a/model-a": {
      publicId: "provider-a/model-a",
      nativeId: "model-a",
      provider: "provider-a"
    },
    "provider-b/model-b": {
      publicId: "provider-b/model-b",
      nativeId: "model-b",
      provider: "provider-b"
    }
  } as const;
  const backend: Backend = {
    defaultModel: "provider-a/model-a",
    ports: borrowedBackendPorts("provider-a/model-a"),
    chat: () => Effect.succeed(Response.json({ choices: [] })),
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  backend.ports = {
    models: {
      ...staticBackendModelPort(backend.defaultModel, {
        reasoningWireShape: "openai-responses"
      }),
      kind: "model-catalog",
      resolve: (requested) =>
        requested === undefined
          ? "provider-a/model-a"
          : Object.hasOwn(routes, requested)
            ? requested
            : undefined,
      resolveRoute: (requested) => {
        const model = requested ?? "provider-a/model-a";
        return Object.hasOwn(routes, model) ? routes[model as keyof typeof routes] : undefined;
      }
    },
    responses: {
      kind: "responses",
      supports: () => true,
      execute: (body) => {
        const request = body as Record<string, unknown>;
        requests.push(request);
        const model = String(request.model);
        const suffix = model === "provider-a/model-a" ? "a" : "b";
        return Effect.succeed(
          Response.json({
            id: `resp_${suffix}`,
            output: [
              {
                type: "reasoning",
                id: `rs_${suffix}`,
                encrypted_content: `raw-${suffix}`,
                summary: []
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: `visible-${suffix}` }]
              }
            ]
          })
        );
      }
    },
    lifecycle: { kind: "borrowed" }
  };
  const gateway = await startGateway({ backend });
  try {
    const first = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "provider-a/model-a",
        input: "start",
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(first.status, 200);
    const firstPayload = (await first.json()) as {
      output: Array<Record<string, unknown>>;
    };
    const encryptedA = String(firstPayload.output[0]?.encrypted_content);
    assert.deepEqual(parseResponsesEncryptedContent(encryptedA), {
      owner: { provider: "provider-a", nativeModel: "model-a" },
      ciphertext: "raw-a"
    });

    const secondInput = [
      { role: "user", content: "start" },
      { type: "reasoning", id: "rs_a", encrypted_content: encryptedA },
      { type: "message", role: "assistant", content: "visible-a" }
    ];
    const second = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "provider-b/model-b",
        input: secondInput,
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(second.status, 200);
    const secondPayload = (await second.json()) as {
      output: Array<Record<string, unknown>>;
    };
    const encryptedB = String(secondPayload.output[0]?.encrypted_content);
    assert.deepEqual(parseResponsesEncryptedContent(encryptedB), {
      owner: { provider: "provider-b", nativeModel: "model-b" },
      ciphertext: "raw-b"
    });
    const sentToB = requests[1] as {
      input: Array<Record<string, unknown>>;
      include?: string[];
    };
    assert.equal(
      sentToB.input.some((item) => item.type === "reasoning"),
      false
    );
    assert.deepEqual(sentToB.include, ["reasoning.encrypted_content"]);

    const third = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "provider-a/model-a",
        input: [
          ...secondInput,
          { type: "reasoning", id: "rs_b", encrypted_content: encryptedB },
          { type: "message", role: "assistant", content: "visible-b" }
        ],
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(third.status, 200);
    const sentBackToA = requests[2] as {
      input: Array<Record<string, unknown>>;
    };
    const reasoning = sentBackToA.input.filter((item) => item.type === "reasoning");
    assert.deepEqual(reasoning, [
      {
        type: "reasoning",
        id: "rs_a",
        encrypted_content: "raw-a"
      }
    ]);
    assert.equal(JSON.stringify(sentBackToA).includes("raw-b"), false);
    assert.equal(JSON.stringify(sentBackToA).includes("rk1."), false);
    assert.deepEqual(
      sentBackToA.input.filter((item) => item.type === "message").map((item) => item.content),
      ["visible-a", "visible-b"]
    );
  } finally {
    await gateway.close();
  }
});

test("native Responses streaming wraps encrypted reasoning in incremental and terminal events", async () => {
  const backend: Backend = {
    defaultModel: "provider-a/model-a",
    ports: borrowedBackendPorts("provider-a/model-a"),
    chat: () => Effect.succeed(Response.json({ choices: [] })),
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  backend.ports = {
    models: {
      ...staticBackendModelPort(backend.defaultModel, {
        reasoningWireShape: "openai-responses"
      }),
      kind: "model-catalog",
      resolveRoute: () => ({
        publicId: "provider-a/model-a",
        nativeId: "model-a",
        provider: "provider-a"
      })
    },
    responses: {
      kind: "responses",
      supports: () => true,
      execute: () =>
        Effect.succeed(
          new Response(
            [
              "event: response.output_item.added\n",
              'data: {"output_index":0,"item":{"type":"reasoning","encrypted_content":"stream-raw"}}\n\n',
              "event: response.output_item.done\n",
              'data: {"output_index":0,"item":{"type":"reasoning","encrypted_content":"stream-raw"}}\n\n',
              "event: response.completed\n",
              'data: {"response":{"output":[{"type":"reasoning","encrypted_content":"stream-raw"}]}}\n\n',
              "data: [DONE]\n\n"
            ].join(""),
            {
              headers: { "content-type": "text/event-stream" }
            }
          )
        )
    },
    lifecycle: { kind: "borrowed" }
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "provider-a/model-a",
        input: "continue",
        stream: true,
        include: ["reasoning.encrypted_content"]
      })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const encrypted = [...text.matchAll(/"encrypted_content":"([^"]+)"/g)].map((match) =>
      parseResponsesEncryptedContent(match[1])
    );
    assert.equal(encrypted.length, 3);
    for (const item of encrypted) {
      assert.deepEqual(item, {
        owner: { provider: "provider-a", nativeModel: "model-a" },
        ciphertext: "stream-raw"
      });
    }
    assert.match(text, /data: \[DONE\]\n\n$/);
  } finally {
    await gateway.close();
  }
});

test("Responses drops legacy encrypted reasoning for unsupported destinations and continues", async () => {
  let calls = 0;
  let outbound: Record<string, unknown> | undefined;
  const backend: import("../backend.js").Backend = {
    defaultModel: "local-model",
    ports: borrowedBackendPorts("local-model"),
    chat: (body) => {
      calls += 1;
      outbound = body as Record<string, unknown>;
      return Effect.succeed(Response.json({ choices: [] }));
    },
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  backend.ports = {
    models: staticBackendModelPort(backend.defaultModel, {
      reasoningWireShape: "openai-chat"
    }),
    responses: { kind: "unsupported" },
    lifecycle: { kind: "borrowed" }
  };
  const gateway = await startGateway({ backend });
  try {
    const encryptedInput = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [{ type: "reasoning", encrypted_content: "opaque" }] })
    });
    assert.equal(encryptedInput.status, 200, await encryptedInput.text());
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(outbound).includes("opaque"), false);

    const includeOnly = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", include: ["reasoning.encrypted_content"] })
    });
    assert.equal(includeOnly.status, 200);
    assert.equal(calls, 2);
  } finally {
    await gateway.close();
  }
});
