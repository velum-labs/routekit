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
import { type Backend, borrowedBackendPorts, ModelRoutedBackend } from "../backend.js";
import { OpenAiBackend } from "../openai-backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { AnthropicBackend, CodexResponsesBackend } from "../provider-backends.js";
import { RoutingBackend } from "../router.js";
import type { RequestRelay } from "../server.js";
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

test("Responses rejects previous_response_id instead of dropping it", async () => {
  let calls = 0;
  const backend: import("../backend.js").Backend = {
    defaultModel: "local-model",
    ports: borrowedBackendPorts("local-model"),
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
      body: JSON.stringify({ input: "continue", previous_response_id: "resp_old" })
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code: string; param: string } };
    assert.equal(error.error.code, "unsupported_previous_response_id");
    assert.equal(error.error.param, "previous_response_id");
    assert.equal(calls, 0);
  } finally {
    await gateway.close();
  }
});

test("responsesToChat forwards a custom tool as a function tool with an {input} schema", () => {
  const body = {
    input: "patch something",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Use this to edit files.",
        format: { type: "grammar", syntax: "lark", definition: "start: PATCH" }
      },
      { type: "function", name: "shell", parameters: { type: "object", properties: { cmd: {} } } }
    ]
  };
  assert.deepEqual(
    [...responsesToolRegistry(body)]
      .filter(([, entry]) => entry.kind === "custom")
      .map(([name]) => name),
    ["apply_patch"]
  );
  const chat = responsesToChat(body, "local-model");
  const tools = chat.tools as Array<{
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  assert.equal(tools.length, 2);
  const patch = tools[0]?.function;
  assert.equal(patch?.name, "apply_patch");
  const properties = patch?.parameters.properties as { input?: { type: string } };
  assert.equal(properties.input?.type, "string");
  assert.deepEqual(patch?.parameters.required, ["input"]);
  // The freeform contract and the grammar are folded into the description.
  assert.match(patch?.description ?? "", /Use this to edit files\./);
  assert.match(patch?.description ?? "", /"input" field/);
  assert.match(patch?.description ?? "", /start: PATCH/);
  // The plain function tool keeps its own schema untouched.
  assert.deepEqual(tools[1]?.function.parameters, { type: "object", properties: { cmd: {} } });
});

test("responsesToChat maps echoed custom_tool_call / custom_tool_call_output items into chat history", () => {
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "apply the patch" },
        { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: PATCH },
        { type: "custom_tool_call_output", call_id: "call_p", output: "Done" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  const toolCalls =
    (
      messages[1] as {
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      }
    ).tool_calls ?? [];
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.id, "call_p");
  assert.equal(toolCalls[0]?.function.name, "apply_patch");
  assert.deepEqual(JSON.parse(toolCalls[0]?.function.arguments ?? ""), { input: PATCH });
  assert.equal(messages[2]?.role, "tool");
  assert.equal((messages[2] as { tool_call_id?: string }).tool_call_id, "call_p");
  assert.equal(messages[2]?.content, "Done");
});

test("chatToResponses emits a custom_tool_call item with raw input for a custom-declared tool", () => {
  const custom = new Map([["apply_patch", { kind: "custom" as const }]]);
  const openai = {
    id: "cmpl-3",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_p",
              function: { name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) }
            },
            { id: "call_s", function: { name: "shell", arguments: '{"cmd":"ls"}' } }
          ]
        }
      }
    ]
  };
  const response = chatToResponses(openai, "route-primary", custom);
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 2);
  assert.equal(output[0]?.type, "custom_tool_call");
  assert.equal(output[0]?.call_id, "call_p");
  assert.equal(output[0]?.name, "apply_patch");
  assert.equal(output[0]?.input, PATCH);
  assert.equal(output[1]?.type, "function_call");
  assert.equal(output[1]?.arguments, '{"cmd":"ls"}');
});

test("chatToResponses translates cached and reasoning token details", () => {
  const response = chatToResponses(
    {
      choices: [{ message: { content: "ok" } }],
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        totalTokens: 19,
        extensions: [
          {
            namespace: "openai.chat.usage-details",
            value: {
              promptTokens: { cached_tokens: 8, audio_tokens: 1 },
              completionTokens: { reasoning_tokens: 5, accepted_prediction_tokens: 2 }
            }
          }
        ]
      }
    },
    "route-primary"
  );
  assert.deepEqual(response.usage, {
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    input_tokens_details: { cached_tokens: 8, audio_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 5, accepted_prediction_tokens: 2 }
  });
});

test("openAiSseToResponses preserves terminal usage details", async () => {
  const upstream = sseStream(
    chatChunk({ content: "ok" }),
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 }
      },
      provider_cost: { source: "provider", cost_usd: 0.002 }
    })}\n\n`,
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "route-primary")).text();
  const completed = text
    .split("\n\n")
    .find((event) => event.startsWith("event: response.completed"));
  assert.ok(completed !== undefined);
  const payload = JSON.parse(completed.slice(completed.indexOf("data:") + 5)) as {
    response: { usage: unknown; provider_cost?: unknown };
  };
  assert.deepEqual(payload.response.usage, {
    input_tokens: 10,
    output_tokens: 6,
    total_tokens: 16,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens_details: { reasoning_tokens: 3 }
  });
  assert.deepEqual(payload.response.provider_cost, {
    source: "provider",
    cost_usd: 0.002
  });
  assert.equal(
    text
      .split("\n\n")
      .filter(
        (event) =>
          event.startsWith("event: response.completed") ||
          event.startsWith("event: response.incomplete") ||
          event.startsWith("event: response.failed")
      ).length,
    1
  );
});

test("encrypted reasoning lifecycle indexes match terminal output positions", async () => {
  const encryptedDelta: Record<PropertyKey, unknown> = {};
  attachResponsesReasoningMetadata(encryptedDelta, {
    items: [
      {
        type: "reasoning",
        id: "rs_encrypted",
        summary: [],
        content: null,
        encrypted_content: "opaque-ciphertext"
      }
    ],
    includeEncryptedContent: true
  });
  const upstream = sseStream(
    chatChunk(encryptedDelta as Record<string, unknown>),
    chatChunk({ reasoning_content: "summary text" }),
    chatChunk({ content: "answer" }),
    chatChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          function: { name: "lookup", arguments: "{}" }
        }
      ]
    }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "route-primary")).text();
  const events = text
    .split("\n\n")
    .filter((event) => event.startsWith("event: "))
    .map(
      (event) =>
        JSON.parse(event.slice(event.indexOf("data:") + 5)) as {
          type: string;
          output_index?: number;
          item?: Record<string, unknown>;
          response?: { output: Array<Record<string, unknown>> };
        }
    );
  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed?.response !== undefined);
  assert.deepEqual(
    completed.response.output.map((item) => item.type),
    ["reasoning", "reasoning", "message", "function_call"]
  );
  assert.equal(completed.response.output[0]?.id, "rs_encrypted");
  for (const event of events.filter(
    (candidate) =>
      candidate.type === "response.output_item.added" ||
      candidate.type === "response.output_item.done"
  )) {
    assert.equal(typeof event.output_index, "number");
    const terminalItem: Record<string, unknown> | undefined =
      completed.response.output[event.output_index as number];
    assert.equal(terminalItem?.type, event.item?.type, JSON.stringify(event));
    if (event.item?.id !== undefined) {
      assert.equal(terminalItem?.id, event.item.id, JSON.stringify(event));
    }
  }
  const encryptedEvents = events.filter((event) => event.item?.id === "rs_encrypted");
  assert.deepEqual(
    encryptedEvents.map((event) => event.type),
    ["response.output_item.added", "response.output_item.done"]
  );
});

test("chatToResponses preserves provider cost metadata", () => {
  const response = chatToResponses(
    {
      id: "cmpl-cost",
      choices: [{ message: { content: "ok" } }],
      usage: { inputTokens: 3, outputTokens: 2 },
      provider_cost: {
        source: "provider",
        cost_usd: 0.0042,
        generation_id: "gen_test"
      }
    },
    "route-primary"
  );

  assert.deepEqual(response.provider_cost, {
    source: "provider",
    cost_usd: 0.0042,
    generation_id: "gen_test"
  });
});

test("chatToResponses passes non-JSON custom tool arguments through as raw input", () => {
  const openai = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_p", function: { name: "apply_patch", arguments: PATCH } }]
        }
      }
    ]
  };
  const response = chatToResponses(
    openai,
    "route-primary",
    new Map([["apply_patch", { kind: "custom" as const }]])
  );
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output[0]?.type, "custom_tool_call");
  assert.equal(output[0]?.input, PATCH);
});

test("openAiSseToResponses streams a custom tool call as custom_tool_call events", async () => {
  const args = JSON.stringify({ input: PATCH });
  const upstream = sseStream(
    chatChunk({
      tool_calls: [
        { index: 0, id: "call_p", function: { name: "apply_patch", arguments: args.slice(0, 12) } }
      ]
    }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(
    openAiSseToResponses(
      upstream,
      "route-primary",
      new Map([["apply_patch", { kind: "custom" as const }]])
    )
  ).text();
  assert.ok(text.includes('"type":"custom_tool_call"'));
  assert.ok(text.includes("event: response.custom_tool_call_input.delta"));
  assert.ok(text.includes("event: response.custom_tool_call_input.done"));
  // The raw patch text (not the JSON wrapper) is what reaches the caller.
  assert.ok(text.includes(JSON.stringify(PATCH).slice(1, -1)));
  assert.ok(
    !text.includes("response.function_call_arguments"),
    "custom calls emit no function-call argument events"
  );
  // The terminal response object carries the completed custom_tool_call item.
  const completed = text
    .split("\n\n")
    .find((event) => event.startsWith("event: response.completed"));
  assert.ok(completed !== undefined);
  const payload = JSON.parse(completed.slice(completed.indexOf("data:") + 5)) as {
    response: { output: Array<{ type: string; name?: string; input?: string }> };
  };
  const item = payload.response.output.find((entry) => entry.type === "custom_tool_call");
  assert.equal(item?.name, "apply_patch");
  assert.equal(item?.input, PATCH);
});

test("responsesToolRegistry classifies function, custom, and client-typed tools", () => {
  const registry = responsesToolRegistry({
    tools: [
      { type: "function", name: "shell", parameters: {} },
      { type: "custom", name: "apply_patch" },
      TOOL_SEARCH_DECL,
      WEB_SEARCH_DECL
    ]
  });
  assert.equal(registry.get("shell")?.kind, "function");
  assert.equal(registry.get("apply_patch")?.kind, "custom");
  assert.equal(registry.get("tool_search")?.kind, "typed");
  // Server-executed typed tools are not callable through the gateway.
  assert.equal(registry.has("web_search"), false);
});

test("responsesToChat projects a client-typed tool under its type and excludes server-typed tools", () => {
  const chat = responsesToChat(
    {
      input: "find tools",
      tools: [
        { type: "function", name: "shell", parameters: {} },
        TOOL_SEARCH_DECL,
        WEB_SEARCH_DECL
      ]
    },
    "local-model"
  );
  const tools = chat.tools as Array<{
    function: { name: string; description?: string; parameters: unknown };
  }>;
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["shell", "tool_search"]
  );
  assert.equal(tools[1]?.function.description, TOOL_SEARCH_DECL.description);
  assert.deepEqual(tools[1]?.function.parameters, TOOL_SEARCH_DECL.parameters);
});

test("responsesToChat resolves a typed tool_choice to the projected function name", () => {
  const chat = responsesToChat(
    { input: "x", tools: [TOOL_SEARCH_DECL], tool_choice: { type: "tool_search" } },
    "local-model"
  );
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "tool_search" } });
});

test("responsesToChat replays echoed typed call/output items into chat history", () => {
  const args = { query: "spawn sub-agent", limit: 8 };
  const discovered = [
    { type: "namespace", name: "multi_agent_v1", tools: [{ name: "spawn_agent" }] }
  ];
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "spawn a sub-agent" },
        {
          type: "tool_search_call",
          call_id: "call_ts",
          status: "completed",
          execution: "client",
          arguments: args
        },
        {
          type: "tool_search_output",
          call_id: "call_ts",
          status: "completed",
          execution: "client",
          tools: discovered
        }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(messages.length, 3);
  const toolCalls =
    (
      messages[1] as {
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      }
    ).tool_calls ?? [];
  assert.equal(toolCalls[0]?.id, "call_ts");
  assert.equal(toolCalls[0]?.function.name, "tool_search");
  assert.deepEqual(JSON.parse(toolCalls[0]?.function.arguments ?? ""), args);
  assert.equal(messages[2]?.role, "tool");
  assert.equal((messages[2] as { tool_call_id?: string }).tool_call_id, "call_ts");
  const result = JSON.parse(String(messages[2]?.content)) as { tools?: unknown };
  assert.deepEqual(result.tools, discovered);
});

test("chatToResponses emits a native typed item for a call resolved as typed", () => {
  const registry = responsesToolRegistry({ tools: [TOOL_SEARCH_DECL] });
  const openai = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_ts",
              function: { name: "tool_search", arguments: '{"query":"spawn","limit":4}' }
            }
          ]
        }
      }
    ]
  };
  const response = chatToResponses(openai, "route-primary", registry);
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, "tool_search_call");
  assert.match(String(output[0]?.id), /^tsc_/);
  assert.ok(!String(output[0]?.id).startsWith("ttc_"));
  assert.equal(output[0]?.call_id, "call_ts");
  assert.equal(output[0]?.execution, "client");
  assert.equal(output[0]?.status, "completed");
  // Native typed items carry arguments as a JSON value, not a string.
  assert.deepEqual(output[0]?.arguments, { query: "spawn", limit: 4 });
});

test("openAiSseToResponses streams a typed tool call as its native item", async () => {
  const registry = responsesToolRegistry({ tools: [TOOL_SEARCH_DECL] });
  const args = '{"query":"spawn sub-agent","limit":8}';
  const upstream = sseStream(
    chatChunk({
      tool_calls: [
        { index: 0, id: "call_ts", function: { name: "tool_search", arguments: args.slice(0, 10) } }
      ]
    }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "route-primary", registry)).text();
  assert.ok(text.includes('"type":"tool_search_call"'));
  assert.ok(!text.includes('"id":"ttc_'));
  assert.ok(
    !text.includes('"type":"function_call"'),
    "typed calls never surface as function_call items"
  );
  assert.ok(
    !text.includes("response.function_call_arguments"),
    "typed calls emit no argument delta events"
  );
  const events = text
    .split("\n\n")
    .filter((event) => event.includes("\ndata: "))
    .map((event) => JSON.parse(event.slice(event.indexOf("data:") + 5)) as Record<string, unknown>);
  const added = events.find((event) => event.type === "response.output_item.added") as
    | { item?: { type?: string; id?: string } }
    | undefined;
  const done = events.find((event) => event.type === "response.output_item.done") as
    | { item?: { type?: string; id?: string } }
    | undefined;
  const completed = events.find((event) => event.type === "response.completed") as
    | {
        response?: {
          output?: Array<{
            type: string;
            id?: string;
            call_id?: string;
            arguments?: unknown;
            execution?: string;
          }>;
        };
      }
    | undefined;
  assert.equal(added?.item?.type, "tool_search_call");
  assert.equal(done?.item?.type, "tool_search_call");
  assert.match(added?.item?.id ?? "", /^tsc_/);
  assert.equal(done?.item?.id, added?.item?.id);
  const payload = completed as {
    response: {
      output: Array<{ type: string; call_id?: string; arguments?: unknown; execution?: string }>;
    };
  };
  const item = payload.response.output.find((entry) => entry.type === "tool_search_call");
  assert.equal((item as { id?: string } | undefined)?.id, added?.item?.id);
  assert.equal(item?.call_id, "call_ts");
  assert.equal(item?.execution, "client");
  assert.deepEqual(item?.arguments, { query: "spawn sub-agent", limit: 8 });
});

test("translated tool_search history keeps a valid item id when switching to native Codex", async () => {
  const source = (sourceId: "codex" | "claude-code") =>
    testProviderSource({
      sourceId,
      discoverModels: () =>
        Effect.succeed([
          {
            id: sourceId === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4-6",
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
      chat: () =>
        Effect.succeed(
          Response.json({
            id: "chatcmpl_tool_search",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_ts",
                      function: {
                        name: "tool_search",
                        arguments: '{"query":"spawn sub-agent","limit":8}'
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        ),
      embeddings: () => Effect.succeed(Response.json({}))
    });
  const backend = await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { codex: {}, "claude-code": {} },
        defaultModel: "claude-code/claude-sonnet-4-6"
      },
      sources: {
        codex: source("codex"),
        "claude-code": source("claude-code")
      }
    })
  );
  let relayedBody: Record<string, unknown> | undefined;
  const relay: RequestRelay = {
    kind: "request",
    dialect: "codex",
    shouldRelay: () => false,
    relay: (_headers, body) => {
      relayedBody = body as Record<string, unknown>;
      return Effect.succeed(
        Response.json({
          id: "resp_native_after_switch",
          object: "response",
          status: "completed",
          model: (body as { model: string }).model,
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
      );
    }
  };
  const gateway = await startGateway({
    backend,
    providerRelays: { codex: { request: relay } }
  });
  try {
    const translated = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code/claude-sonnet-4-6",
        input: "find a sub-agent tool",
        tools: [TOOL_SEARCH_DECL]
      })
    });
    assert.equal(translated.status, 200);
    const translatedPayload = (await translated.json()) as {
      output: Array<Record<string, unknown>>;
    };
    const toolSearchCall = translatedPayload.output.find(
      (item) => item.type === "tool_search_call"
    );
    assert.ok(toolSearchCall !== undefined);
    assert.match(String(toolSearchCall.id), /^tsc_/);
    assert.equal(toolSearchCall.call_id, "call_ts");

    const switched = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          toolSearchCall,
          {
            type: "tool_search_output",
            call_id: "call_ts",
            status: "completed",
            execution: "client",
            tools: []
          }
        ]
      })
    });
    assert.equal(switched.status, 200);
    const relayedInput = relayedBody?.input as Array<Record<string, unknown>> | undefined;
    assert.equal(relayedInput?.[0]?.id, toolSearchCall.id);
    assert.equal(relayedInput?.[0]?.call_id, "call_ts");
  } finally {
    await gateway.close();
  }
});

test("openAiSseToResponses keeps function tools on the incremental function_call path", async () => {
  const upstream = sseStream(
    chatChunk({
      tool_calls: [
        { index: 0, id: "call_s", function: { name: "shell", arguments: '{"cmd":"ls"}' } }
      ]
    }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(
    openAiSseToResponses(
      upstream,
      "route-primary",
      new Map([["apply_patch", { kind: "custom" as const }]])
    )
  ).text();
  assert.ok(text.includes('"type":"function_call"'));
  assert.ok(text.includes("event: response.function_call_arguments.delta"));
  assert.ok(!text.includes("custom_tool_call"));
});
