import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  anthropicModelsResponse,
  anthropicToChat,
  chatToAnthropicMessage,
  mapStopReason,
  openAiSseToAnthropic,
  resolveClaudeModelSelection,
  withClaudeReasoningSelection
} from "../adapters/anthropic.js";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  ANTHROPIC_REQUEST_METADATA,
  type AnthropicNativeContentBlock,
  type AnthropicRequestMetadata
} from "../adapters/openai-chat-wire.js";
import { OpenAiBackend } from "../openai-backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { RoutingBackend } from "../router.js";
import type { RequestRelay } from "../server.js";
import { startGateway } from "../server.js";
import { testProviderSource } from "./provider-source-fixture.js";

/**
 * M2 coverage: the Anthropic Messages adapter against a mock OpenAI backend.
 * Verifies request translation (system, tools, tool results), non-streaming
 * and streaming response shapes, count_tokens, and discovery.
 */

test("anthropicModelsResponse keeps canonical route ids and emits no effort variants", async () => {
  const res = anthropicModelsResponse("route-primary", [
    "route-primary",
    "claude-opus-4-8",
    "gpt-5.5",
    "mlx-community/Qwen3-1.7B-4bit"
  ]);
  const body = (await res.json()) as { data: Array<{ id: string; display_name: string }> };
  assert.deepEqual(
    body.data.map((model) => model.id),
    ["route-primary", "claude-opus-4-8", "gpt-5.5", "mlx-community/Qwen3-1.7B-4bit"]
  );
  assert.ok(body.data.every((model) => !model.id.includes(":")));
  const gpt = body.data.find((model) => model.id === "gpt-5.5");
  assert.equal(gpt?.display_name, "gpt-5.5");
});

test("Claude selection accepts picker ids and unique native ids but rejects collisions", () => {
  const reasoning = {
    status: "supported" as const,
    efforts: [{ id: "low" }, { id: "high", aliases: ["max"] }, { id: "high" }],
    provenance: "provider" as const
  };
  assert.deepEqual(
    resolveClaudeModelSelection(
      "anthropic.routekit.codex/gpt-5.5",
      ["openai/gpt-5.5", "fast", "codex/gpt-5.5"],
      [
        { publicId: "openai/gpt-5.5", nativeId: "gpt-5.5", provider: "openai", reasoning },
        { publicId: "fast", nativeId: "gpt-5.5", provider: "openai", reasoning },
        { publicId: "codex/gpt-5.5", nativeId: "gpt-5.5", provider: "codex", reasoning }
      ]
    ),
    {
      status: "resolved",
      model: "codex/gpt-5.5",
      clientModel: "anthropic.routekit.codex/gpt-5.5",
      selection: { mode: "auto" }
    }
  );
  assert.deepEqual(
    resolveClaudeModelSelection(
      "gpt-5.5",
      ["openai/gpt-5.5", "fast"],
      [
        { publicId: "openai/gpt-5.5", nativeId: "gpt-5.5", provider: "openai", reasoning },
        { publicId: "fast", nativeId: "gpt-5.5", provider: "openai", reasoning }
      ]
    ),
    {
      status: "resolved",
      model: "openai/gpt-5.5",
      clientModel: "gpt-5.5",
      selection: { mode: "auto" }
    }
  );
  const collision = resolveClaudeModelSelection(
    "gpt-5.5",
    ["openai/gpt-5.5", "codex/gpt-5.5"],
    [
      { publicId: "openai/gpt-5.5", nativeId: "gpt-5.5", provider: "openai", reasoning },
      { publicId: "codex/gpt-5.5", nativeId: "gpt-5.5", provider: "codex", reasoning }
    ]
  );
  assert.equal(collision.status, "ambiguous_model");
  if (collision.status === "ambiguous_model") {
    assert.match(collision.message, /codex\/gpt-5\.5, openai\/gpt-5\.5/);
  }
  assert.deepEqual(
    withClaudeReasoningSelection(
      { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
      { mode: "effort", effort: "high" }
    ),
    {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" }
    }
  );
});

test("anthropicToChat tolerates thinking: null (same failure class as Responses reasoning: null)", () => {
  const chat = anthropicToChat(
    { model: "claude-x", messages: [{ role: "user", content: "hi" }], thinking: null },
    "claude-x"
  );
  assert.equal(chat.reasoning_effort, undefined);
});

type Mock = {
  url: string;
  lastChatBody: () => Record<string, unknown> | undefined;
  lastModelCallId: () => string | undefined;
  close: () => Promise<void>;
};

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startMock(): Promise<Mock> {
  let lastChatBody: Record<string, unknown> | undefined;
  let lastModelCallId: string | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const body = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
      lastChatBody = body;
      lastModelCallId =
        typeof req.headers[MODEL_CALL_ID_HEADER] === "string"
          ? req.headers[MODEL_CALL_ID_HEADER]
          : undefined;
      if (body.stream === true) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sendJson(res, 200, {
        id: "cmpl-1",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello there" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 }
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    lastChatBody: () => lastChatBody,
    lastModelCallId: () => lastModelCallId,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

test("anthropicToChat maps system, tools, and tool results", () => {
  const chat = anthropicToChat(
    {
      model: "claude-x",
      system: "be terse",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "result text" }]
        }
      ],
      tools: [{ name: "search", description: "find", input_schema: { type: "object" } }]
    },
    "local-model"
  );

  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(chat.model, "local-model");
  // Modern spelling: OpenAI reasoning models reject legacy `max_tokens`.
  assert.equal(chat.max_completion_tokens, 100);
  assert.equal(chat.max_tokens, undefined);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[2]?.role, "assistant");
  assert.ok(Array.isArray((messages[2] as { tool_calls?: unknown[] }).tool_calls));
  assert.equal(messages[3]?.role, "tool");
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "tu_1");
  const tools = chat.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools[0]?.function.name, "search");
});

test("anthropicToChat treats explicit null optional fields as absent", () => {
  // Some clients encode "unset" as an explicit JSON null (Codex does on the
  // Responses wire); a null `thinking`/`tool_choice`/`system` must translate
  // like an absent field instead of crashing the turn.
  const chat = anthropicToChat(
    {
      model: "claude-x",
      system: null,
      messages: [{ role: "user", content: "hi" }],
      thinking: null,
      metadata: null,
      tool_choice: null
    },
    "local-model"
  );
  assert.deepEqual(chat.messages, [{ role: "user", content: "hi" }]);
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.tool_choice, undefined);
});

test("anthropicToChat keeps disabled thinking disabled despite output effort", () => {
  const chat = anthropicToChat(
    {
      max_tokens: 4096,
      thinking: { type: "disabled" },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "answer directly" }]
    },
    "gpt-route"
  );
  assert.equal(chat.reasoning_effort, undefined);
});

test("anthropicToChat preserves exact controls and signed/redacted history in-process", () => {
  const chat = anthropicToChat(
    {
      model: "claude-x",
      max_tokens: 4096,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "xhigh" },
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "private",
              signature: "sig-valid"
            },
            { type: "redacted_thinking", data: "opaque" },
            {
              type: "tool_use",
              id: "tool_1",
              name: "read",
              input: { path: "a.ts" }
            }
          ]
        }
      ]
    },
    "claude-x"
  ) as Record<PropertyKey, unknown>;
  const metadata = chat[ANTHROPIC_REQUEST_METADATA] as AnthropicRequestMetadata | undefined;
  assert.deepEqual(metadata, {
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "xhigh" }
  });
  assert.equal(chat.reasoning_effort, "xhigh");
  const assistant = (chat.messages as Array<Record<PropertyKey, unknown>>)[1];
  const native = assistant?.[ANTHROPIC_MESSAGE_CONTENT] as
    | AnthropicNativeContentBlock[]
    | undefined;
  assert.deepEqual(
    native?.map((block) => block.type),
    ["thinking", "redacted_thinking", "tool_use"]
  );
  assert.equal((native?.[0] as { signature?: string } | undefined)?.signature, "sig-valid");
});

test("anthropicToChat never replays synthetic thinking with an empty signature", () => {
  const chat = anthropicToChat(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "display only", signature: "" },
            { type: "text", text: "answer" }
          ]
        }
      ]
    },
    "claude-x"
  ) as { messages: Array<Record<PropertyKey, unknown>> };
  assert.equal(chat.messages[0]?.[ANTHROPIC_MESSAGE_CONTENT], undefined);
  assert.equal(chat.messages[0]?.content, "answer");
});

test("anthropicToChat projects typed client tools but excludes server-executed tools", () => {
  const chat = anthropicToChat(
    {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        // Plain client tool (Claude Code's sub-agent door) — always projected.
        { name: "Task", description: "spawn a sub-agent", input_schema: { type: "object" } },
        // Anthropic-defined *client* tool: caller executes it via tool_use.
        { type: "bash_20250124", name: "bash" },
        // Server-executed tools: nothing behind the gateway can run them.
        { type: "web_search_20250305", name: "web_search", max_uses: 5 } as never,
        { type: "code_execution_20250522", name: "code_execution" }
      ]
    },
    "local-model"
  );
  const tools = chat.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["Task", "bash"]
  );
});

test("anthropicToChat groups parallel tool_use into one assistant message", () => {
  // Anthropic batches parallel tool calls as multiple tool_use blocks in a
  // single assistant message; they must stay one assistant message followed by
  // the tool results so the chat API's tool_calls pairing stays valid.
  const chat = anthropicToChat(
    {
      messages: [
        { role: "user", content: "do both" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_a", name: "read_file", input: { path: "a" } },
            { type: "tool_use", id: "tu_b", name: "read_file", input: { path: "b" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_a", content: "A" },
            { type: "tool_result", tool_use_id: "tu_b", content: "B" }
          ]
        }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  const assistant = messages.find((m) => m.role === "assistant") as {
    tool_calls?: Array<{ id: string }>;
  };
  assert.equal(assistant.tool_calls?.length, 2);
  assert.deepEqual(
    assistant.tool_calls?.map((call) => call.id),
    ["tu_a", "tu_b"]
  );
  const toolMessages = messages.filter((m) => m.role === "tool") as Array<{ tool_call_id: string }>;
  assert.deepEqual(
    toolMessages.map((m) => m.tool_call_id),
    ["tu_a", "tu_b"]
  );
});

test("anthropic streaming starts eagerly and pings while the upstream is silent", async () => {
  // A never-ending upstream simulates a slow provider before its first token.
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    }
  });
  const decoder = new TextDecoder();
  const reader = openAiSseToAnthropic(upstream, "claude-x").getReader();
  try {
    // message_start must arrive before any upstream data is produced.
    const first = await reader.read();
    assert.ok(first.value !== undefined);
    assert.ok(decoder.decode(first.value).includes("event: message_start"));

    // A ping keepalive must arrive while the upstream is still silent.
    let sawPing = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined && decoder.decode(value).includes("event: ping")) {
        sawPing = true;
        break;
      }
    }
    assert.ok(sawPing, "a ping keepalive must be emitted while the upstream is silent");
  } finally {
    await reader.cancel();
    // cancel() already propagates to the upstream; closing again is a no-op.
    try {
      upstreamController.close();
    } catch {
      // already closed via cancel
    }
  }
});

test("streams a routed tool call end to end as Anthropic tool_use blocks", async () => {
  // OpenAI-chat SSE with a tool call whose arguments arrive fragmented across
  // chunks, then a tool_calls finish. The adapter must reconstruct one tool_use
  // block with the fully-merged JSON input.
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const decoder = new TextDecoder();
  const reader = openAiSseToAnthropic(upstream, "claude-x").getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out += decoder.decode(value);
  }
  assert.ok(out.includes('"type":"tool_use"'), "a tool_use content block must be emitted");
  assert.ok(out.includes('"name":"search"'), "the tool name must be carried through");
  assert.ok(out.includes("input_json_delta"), "the arguments must stream as input_json_delta");
  // Both fragments ("{\"q\": and \"cats\"}) must reach the client.
  assert.ok(out.includes("cats"), "both argument fragments must be forwarded");
  assert.ok(out.includes('"stop_reason":"tool_use"'), "tool_calls maps to a tool_use stop reason");
});

test("truncated stream (no finish_reason) surfaces an Anthropic error, not end_turn", async () => {
  // Upstream ends after some content but never sends a finish_reason / [DONE].
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      controller.close();
    }
  });
  const decoder = new TextDecoder();
  const reader = openAiSseToAnthropic(upstream, "claude-x").getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out += decoder.decode(value);
  }
  assert.ok(out.includes("event: error"), "a truncated stream must emit an error event");
  assert.ok(
    !out.includes('"stop_reason":"end_turn"'),
    "truncation must not fabricate a clean end_turn"
  );
});

test("an OpenAI mid-stream error becomes a native Anthropic error event", async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"error":{"message":"provider overloaded","type":"provider_error"}}\n\n'
        )
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  const output = await new Response(openAiSseToAnthropic(upstream, "claude-x")).text();

  assert.match(output, /event: error/);
  assert.match(output, /provider overloaded/);
  assert.match(output, /provider_error/);
  assert.doesNotMatch(output, /incomplete_stream/);
  assert.doesNotMatch(output, /"stop_reason":"end_turn"/);
});

test("chatToAnthropicMessage produces a text content block", () => {
  const message = chatToAnthropicMessage(
    {
      id: "cmpl-9",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { inputTokens: 4, outputTokens: 1 }
    },
    "claude-x"
  );
  assert.equal(message.type, "message");
  const content = message.content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[0]?.text, "hi");
  assert.equal(message.stop_reason, "end_turn");
});

test("chatToAnthropicMessage restores signed and redacted native reasoning blocks", () => {
  const message = chatToAnthropicMessage(
    {
      id: "cmpl-native",
      choices: [
        {
          message: {
            content: "answer",
            reasoning: "visible thought",
            reasoning_content: "**gateway narration**",
            reasoning_details: [
              {
                text: "visible thought",
                extensions: [
                  {
                    namespace: "anthropic.reasoning",
                    value: { index: 0, signature: "sig-native" }
                  }
                ]
              },
              {
                encryptedContent: "opaque-native",
                extensions: [
                  {
                    namespace: "anthropic.reasoning",
                    value: { index: 1, redacted: true }
                  }
                ]
              }
            ]
          },
          finish_reason: "stop"
        }
      ]
    },
    "claude-x"
  );
  const content = message.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    content.map((block) => block.type),
    ["thinking", "redacted_thinking", "thinking", "text"]
  );
  assert.equal(content[0]?.signature, "sig-native");
  assert.equal(content[1]?.data, "opaque-native");
  assert.equal(content[2]?.thinking, "gateway narration");
});

test("Anthropic response conversion ignores malformed untrusted reasoning details", () => {
  const message = chatToAnthropicMessage(
    {
      choices: [
        {
          message: {
            content: "safe",
            reasoning_details: [
              { type: "attacker_block", index: 0, phase: "start", data: "leak" },
              { type: "redacted_thinking", index: 1, data: 42 }
            ] as never
          },
          finish_reason: "stop"
        }
      ]
    },
    "claude-x"
  );
  assert.deepEqual(
    (message.content as Array<Record<string, unknown>>).map((block) => block.type),
    ["text"]
  );
});

test("chatToAnthropicMessage restores provider-native stop metadata", () => {
  const message = chatToAnthropicMessage(
    {
      choices: [
        {
          message: { content: "bounded" },
          finish_reason: "stop",
          anthropic_stop_reason: "stop_sequence",
          anthropic_stop_sequence: "<END>"
        }
      ]
    },
    "claude-x"
  );
  assert.equal(message.stop_reason, "stop_sequence");
  assert.equal(message.stop_sequence, "<END>");
});

test("openAiSseToAnthropic restores native thinking lifecycle and signature deltas", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    {
      reasoning_details: [{ type: "thinking", index: 0, phase: "start", signature: "" }]
    },
    {
      reasoning: "native thought",
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          phase: "delta",
          thinking: "native thought"
        }
      ]
    },
    { reasoning_content: "**gateway narration**\n\n" },
    {
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          phase: "signature",
          signature: "sig-stream"
        }
      ]
    },
    {
      reasoning_details: [{ type: "thinking", index: 0, phase: "stop" }]
    },
    {
      reasoning_details: [
        {
          type: "redacted_thinking",
          index: 1,
          phase: "block",
          data: "opaque-stream"
        }
      ]
    },
    { content: "answer" }
  ];
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta, finish_reason: null }]
            })}\n\n`
          )
        );
      }
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  const text = await new Response(openAiSseToAnthropic(upstream, "claude-x")).text();
  assert.match(text, /"type":"thinking_delta","thinking":"native thought"/);
  assert.match(text, /"type":"signature_delta","signature":"sig-stream"/);
  assert.match(text, /"type":"thinking_delta","thinking":"gateway narration\\n\\n"/);
  assert.match(text, /"type":"redacted_thinking","data":"opaque-stream"/);
  assert.equal(
    text.match(/"type":"thinking_delta","thinking":"native thought"/g)?.length,
    1,
    "portable reasoning must not duplicate the native detail delta"
  );
  assert.ok(
    text.indexOf('"type":"signature_delta"') < text.indexOf('"thinking":"gateway narration')
  );
  assert.ok(
    text.indexOf('"thinking":"gateway narration') < text.indexOf('"type":"redacted_thinking"')
  );
  assert.ok(text.indexOf('"type":"redacted_thinking"') < text.indexOf('"type":"text_delta"'));
});

test("mapStopReason maps tool_calls to tool_use", () => {
  assert.equal(mapStopReason("tool_calls"), "tool_use");
  assert.equal(mapStopReason("length"), "max_tokens");
  assert.equal(mapStopReason("stop"), "end_turn");
});

test("serves a non-streaming Anthropic message end to end", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 50,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(mock.lastModelCallId(), response.headers.get(MODEL_CALL_ID_HEADER));
    const json = (await response.json()) as {
      type: string;
      content: Array<{ type: string; text?: string }>;
      model: string;
    };
    assert.equal(json.type, "message");
    assert.equal(json.model, "claude-x");
    assert.equal(json.content[0]?.text, "Hello there");
    // Upstream got the backend model, not the claude id.
    assert.equal(mock.lastChatBody()?.model, "local-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("rejects impossible Anthropic thinking budgets before provider routing", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "gpt-route" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-gpt-route",
        max_tokens: 2048,
        thinking: { type: "enabled", budget_tokens: 2048 },
        messages: [{ role: "user", content: "think" }]
      })
    });
    assert.equal(response.status, 400);
    assert.equal(mock.lastChatBody(), undefined);
    assert.match(await response.text(), /budget_tokens must be less than max_tokens/);
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("translates a streamed Anthropic message", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-x",
        max_tokens: 50,
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("event: message_start"));
    assert.ok(text.includes("event: content_block_start"));
    assert.ok(text.includes('"type":"text_delta","text":"Hel"'));
    assert.ok(text.includes("event: message_stop"));
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("estimates tokens and serves Anthropic discovery", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const count = await fetch(`${gateway.url()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-x",
        messages: [{ role: "user", content: "hello world" }]
      })
    });
    assert.equal(count.status, 200);
    const counted = (await count.json()) as { input_tokens: number };
    assert.ok(counted.input_tokens > 0);

    const models = await fetch(`${gateway.url()}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01" }
    });
    const list = (await models.json()) as { data: Array<{ id: string }> };
    assert.equal(list.data[0]?.id, "local-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("Claude's implicit thinking default does not reject a base model without reasoning controls", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const backend = await RoutingBackend.create({
    config: {
      providers: { openai: {} },
      defaultModel: "openai/mock-model"
    },
    sources: {
      openai: testProviderSource({
        sourceId: "openai",
        async discoverModels() {
          return [{ id: "mock-model" }];
        },
        async chat(body: unknown) {
          calls.push(body as Record<string, unknown>);
          return Response.json({
            id: "chatcmpl_no_reasoning",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          });
        },
        async embeddings() {
          return Response.json({});
        }
      })
    }
  });
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "anthropic.routekit.openai/mock-model",
        max_tokens: 32,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.reasoning_effort, undefined);
  } finally {
    await gateway.close();
  }
});

test("Claude picker ids and bare native ids use the canonical catalog and pooled native relay", async () => {
  const sourceCalls: string[] = [];
  const source = (sourceId: "claude-code" | "codex") =>
    testProviderSource({
      sourceId,
      discoverModels: async () => [
        {
          id: sourceId === "claude-code" ? "claude-sonnet-4-6" : "gpt-5.5"
        }
      ],
      chat: async (body: unknown) => {
        sourceCalls.push((body as { model: string }).model);
        return Response.json({
          id: "chatcmpl_cross_provider",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "CROSS_PROVIDER_OK" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        });
      },
      embeddings: async () => Response.json({})
    });
  const backend = await RoutingBackend.create({
    config: {
      providers: { "claude-code": {}, codex: {} },
      defaultModel: "claude-code/claude-sonnet-4-6"
    },
    sources: {
      "claude-code": source("claude-code"),
      codex: source("codex")
    }
  });
  const relayedBodies: Array<Record<string, unknown>> = [];
  const relay: RequestRelay = {
    kind: "request",
    dialect: "anthropic",
    shouldRelay: () => false,
    relay: async (_headers, body) => {
      relayedBodies.push(body as unknown as Record<string, unknown>);
      return Response.json({
        id: "msg_native",
        type: "message",
        role: "assistant",
        model: (body as { model: string }).model,
        content: [{ type: "text", text: "NATIVE_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      });
    }
  };
  const gateway = await startGateway({
    backend,
    providerRelays: { anthropic: { request: relay } }
  });
  try {
    const catalog = (await (
      await fetch(`${gateway.url()}/v1/models`, {
        headers: { "anthropic-version": "2023-06-01" }
      })
    ).json()) as {
      data: Array<{ id: string; display_name: string }>;
    };
    assert.deepEqual(
      catalog.data.map(({ id, display_name }) => [id, display_name]),
      [
        ["codex/gpt-5.5", "codex/gpt-5.5"],
        ["claude-code/claude-sonnet-4-6", "claude-code/claude-sonnet-4-6"]
      ]
    );

    for (const model of [
      "anthropic.routekit.claude-code/claude-sonnet-4-6",
      "claude-sonnet-4-6",
      "claude-code/claude-sonnet-4-6"
    ]) {
      const response = await fetch(`${gateway.url()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          system: "Preserve native Anthropic fields.",
          messages: [{ role: "user", content: "hi" }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { content: Array<{ text: string }> }).content[0]?.text,
        "NATIVE_OK"
      );
    }
    assert.deepEqual(
      relayedBodies.map((body) => body.model),
      ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"]
    );
    assert.ok(relayedBodies.every((body) => body.system === "Preserve native Anthropic fields."));
    assert.deepEqual(sourceCalls, []);

    const unknown = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-not-real",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown model/);
    assert.deepEqual(
      relayedBodies.map((body) => body.model),
      ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"]
    );
  } finally {
    await gateway.close();
  }
});

test("Claude rejects an ambiguous bare native model before provider routing", async () => {
  const sourceCalls: string[] = [];
  const source = (sourceId: "openai" | "codex") =>
    testProviderSource({
      sourceId,
      discoverModels: async () => [{ id: "gpt-5.5" }],
      chat: async (body: unknown) => {
        sourceCalls.push((body as { model: string }).model);
        return Response.json({});
      },
      embeddings: async () => Response.json({})
    });
  const backend = await RoutingBackend.create({
    config: {
      providers: { openai: {}, codex: {} },
      defaultModel: "openai/gpt-5.5"
    },
    sources: { openai: source("openai"), codex: source("codex") }
  });
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as {
      error: { type: string; message: string };
    };
    assert.equal(payload.error.type, "invalid_request_error");
    assert.match(payload.error.message, /codex\/gpt-5\.5, openai\/gpt-5\.5/);
    assert.deepEqual(sourceCalls, []);
  } finally {
    await gateway.close();
  }
});

test("Claude native effort applies request-scoped effort on picker and bare-native routes", async () => {
  const reasoning = {
    status: "supported" as const,
    efforts: [{ id: "low" }, { id: "high", aliases: ["max"] }],
    provenance: "provider" as const
  };
  const sourceCalls: Array<Record<string, unknown>> = [];
  const source = (sourceId: "claude-code" | "codex") =>
    testProviderSource({
      sourceId,
      discoverModels: async () => [
        {
          id: sourceId === "claude-code" ? "claude-sonnet-4-6" : "gpt-5.5",
          reasoning
        }
      ],
      chat: async (body: unknown) => {
        sourceCalls.push(body as Record<string, unknown>);
        return Response.json({
          id: "chatcmpl_effort",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "TRANSLATED_OK" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        });
      },
      embeddings: async () => Response.json({})
    });
  const backend = await RoutingBackend.create({
    config: {
      providers: { "claude-code": {}, codex: {} },
      defaultModel: "claude-code/claude-sonnet-4-6"
    },
    sources: {
      "claude-code": source("claude-code"),
      codex: source("codex")
    }
  });
  const relayedBodies: Array<Record<string, unknown>> = [];
  const relay: RequestRelay = {
    kind: "request",
    dialect: "anthropic",
    shouldRelay: () => false,
    relay: async (_headers, body) => {
      relayedBodies.push(body as unknown as Record<string, unknown>);
      return Response.json({
        id: "msg_effort",
        type: "message",
        role: "assistant",
        model: (body as { model: string }).model,
        content: [{ type: "text", text: "NATIVE_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      });
    }
  };
  const gateway = await startGateway({
    backend,
    providerRelays: { anthropic: { request: relay } }
  });
  try {
    const catalog = (await (
      await fetch(`${gateway.url()}/v1/models`, {
        headers: { "anthropic-version": "2023-06-01" }
      })
    ).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(
      catalog.data.map((model) => model.id),
      ["codex/gpt-5.5", "claude-code/claude-sonnet-4-6"]
    );

    for (const effort of ["low", "high"] as const) {
      const response = await fetch(`${gateway.url()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "anthropic.routekit.claude-code/claude-sonnet-4-6",
          max_tokens: 32,
          thinking: { type: "adaptive" },
          output_config: { effort },
          messages: [{ role: "user", content: "hi" }]
        })
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(
      relayedBodies.map((body) => [
        body.model,
        (body.thinking as { type?: string } | undefined)?.type,
        (body.output_config as { effort?: string } | undefined)?.effort
      ]),
      [
        ["claude-sonnet-4-6", "adaptive", "low"],
        ["claude-sonnet-4-6", "adaptive", "high"]
      ]
    );

    const base = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(base.status, 200);
    assert.equal(relayedBodies.at(-1)?.output_config, undefined);
    assert.equal(relayedBodies.at(-1)?.thinking, undefined);

    const translated = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "anthropic.routekit.codex/gpt-5.5",
        max_tokens: 32,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(translated.status, 200);
    assert.equal(sourceCalls.length, 1);
    assert.equal(sourceCalls[0]?.model, "gpt-5.5");
    assert.equal(sourceCalls[0]?.reasoning_effort, "high");

    const passthrough = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "anthropic.routekit.claude-code/claude-sonnet-4-6",
        max_tokens: 32,
        thinking: { type: "adaptive" },
        output_config: { effort: "bogus" },
        messages: [{ role: "user", content: "hi" }]
      })
    });
    // Claude Code owns the native effort selector. RouteKit must preserve an
    // unrecognised value for the provider rather than validating it against a
    // stale discovery catalog or reintroducing synthetic effort model ids.
    assert.equal(passthrough.status, 200);
    assert.deepEqual(relayedBodies.at(-1)?.output_config, { effort: "bogus" });
    assert.deepEqual(relayedBodies.at(-1)?.thinking, { type: "adaptive" });
    assert.equal(relayedBodies.length, 4);
    assert.equal(sourceCalls.length, 1);

    const retrieve = await fetch(
      `${gateway.url()}/v1/models/${encodeURIComponent("anthropic.routekit.claude-code/claude-sonnet-4-6")}`,
      { headers: { "anthropic-version": "2023-06-01" } }
    );
    assert.equal(retrieve.status, 200);
    assert.equal(
      ((await retrieve.json()) as { id: string }).id,
      "anthropic.routekit.claude-code/claude-sonnet-4-6"
    );
  } finally {
    await gateway.close();
  }
});
