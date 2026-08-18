import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { test } from "node:test";
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
import { startGateway } from "../server.js";

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

test("responsesToChat maps instructions, input items, and function output", () => {
  const chat = responsesToChat(
    {
      model: "gpt-x",
      instructions: "be terse",
      input: [
        { type: "message", role: "user", content: "search please" },
        { type: "function_call", call_id: "call_1", name: "search", arguments: '{"q":"x"}' },
        { type: "function_call_output", call_id: "call_1", output: "found" }
      ],
      tools: [
        { type: "function", name: "search", description: "find", parameters: { type: "object" } }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(chat.model, "local-model");
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[2]?.role, "assistant");
  assert.ok(Array.isArray((messages[2] as { tool_calls?: unknown[] }).tool_calls));
  assert.equal(messages[3]?.role, "tool");
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "call_1");
  const tools = chat.tools as Array<{ function: { name: string } }>;
  assert.equal(tools[0]?.function.name, "search");
});

test("responsesToChat coalesces parallel function calls into one assistant message", () => {
  // Codex emits parallel tool calls as separate function_call items; they must
  // become a single assistant message so the following tool messages answer it
  // (the chat API rejects an assistant tool_calls message that is not directly
  // followed by tool responses for each tool_call_id).
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "fix it" },
        {
          type: "function_call",
          call_id: "call_a",
          name: "read_file",
          arguments: '{"path":"a.js"}'
        },
        {
          type: "function_call",
          call_id: "call_b",
          name: "read_file",
          arguments: '{"path":"b.js"}'
        },
        { type: "function_call_output", call_id: "call_a", output: "A" },
        { type: "function_call_output", call_id: "call_b", output: "B" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  // user, assistant(tool_calls:[a,b]), tool(a), tool(b)
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.role, "assistant");
  const toolCalls = (messages[1] as { tool_calls?: Array<{ id: string }> }).tool_calls ?? [];
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(
    toolCalls.map((call) => call.id),
    ["call_a", "call_b"]
  );
  assert.equal(messages[2]?.role, "tool");
  assert.equal((messages[2] as { tool_call_id?: string }).tool_call_id, "call_a");
  assert.equal(messages[3]?.role, "tool");
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "call_b");
});

test("responsesToChat folds an assistant text item and its following function calls into one message", () => {
  // A model that answers with text + tool calls in a single turn comes back
  // from Codex as a message item followed by function_call items (with the
  // echoed reasoning item in between). Replaying them as two assistant
  // messages derails tool-calling models (qwen3-coder stops mid-task with a
  // text-only "Now let me check X:" turn), so they must merge back into one.
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "what's in this repo?" },
        { type: "message", role: "assistant", content: "Let me check the README:\n\n" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "beat" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"cat README.md"}'
        },
        { type: "function_call_output", call_id: "call_1", output: "# RouteKit" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  // user, assistant(content + tool_calls), tool — NOT a separate tool_calls message.
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.content, "Let me check the README:\n\n");
  const toolCalls = (messages[1] as { tool_calls?: Array<{ id: string }> }).tool_calls ?? [];
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.id, "call_1");
  assert.equal(messages[2]?.role, "tool");
});

test("responsesToChat does not fold function calls into a non-adjacent assistant message", () => {
  // An earlier assistant answer separated from the calls by a user turn must
  // stay text-only; the calls get their own assistant message in position.
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "Done." },
        { type: "message", role: "user", content: "now run ls" },
        {
          type: "function_call",
          call_id: "call_2",
          name: "exec_command",
          arguments: '{"cmd":"ls"}'
        },
        { type: "function_call_output", call_id: "call_2", output: "files" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  // user, assistant(text), user, assistant(tool_calls), tool
  assert.equal(messages.length, 5);
  assert.equal((messages[1] as { tool_calls?: unknown }).tool_calls, undefined);
  assert.equal(messages[3]?.role, "assistant");
  assert.equal(messages[3]?.content, null);
  const toolCalls = (messages[3] as { tool_calls?: Array<{ id: string }> }).tool_calls ?? [];
  assert.equal(toolCalls[0]?.id, "call_2");
});

test("responsesToChat tolerates reasoning: null and text: null (Codex custom-provider slugs)", () => {
  // Regression (ENG-615): Codex serializes `reasoning: null` for any model
  // slug it cannot resolve to reasoning metadata — which includes custom
  // endpoints routed through a compatible gateway (e.g. `grok-4`, `deepseek`).
  // The adapter used to dereference it (`Cannot read properties of null
  // (reading 'effort')`), turning EVERY member request into a 502 and the
  // whole custom-endpoint response into an `exit_error`.
  const chat = responsesToChat(
    { model: "grok-4", input: "say OK", reasoning: null, text: null, stream: true },
    "grok-4"
  );
  assert.equal(chat.model, "grok-4");
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.response_format, undefined);
});

test("responsesToChat treats Codex reasoning effort null as absent", () => {
  const chat = responsesToChat(
    { model: "gpt-5.5", input: "say OK", reasoning: { effort: null } },
    "gpt-5.5"
  );
  assert.equal(chat.reasoning_effort, undefined);
});

test("responsesToChat still maps a real reasoning effort", () => {
  const chat = responsesToChat(
    { model: "gpt-5.5", input: "say OK", reasoning: { effort: "medium" } },
    "gpt-5.5"
  );
  assert.equal(chat.reasoning_effort, "medium");
});

test("responsesToChat treats Codex's explicit null fields as absent", () => {
  // Codex sends `"reasoning": null` (and can null other optional fields) when
  // the selected model's metadata advertises no reasoning levels — the default
  // for a custom-provider model. Reading `.effort` off
  // that null used to throw, turning every custom-provider Codex turn into a 502 (and
  // leaving the --observe dashboard empty because no turn ever ran).
  const chat = responsesToChat(
    {
      model: "route-primary",
      input: "say hi",
      reasoning: null,
      text: null,
      tool_choice: null,
      metadata: null,
      previous_response_id: null,
      include: []
    },
    "local-model"
  );
  assert.equal(chat.model, "local-model");
  assert.deepEqual(chat.messages, [{ role: "user", content: "say hi" }]);
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.response_format, undefined);
  assert.equal(chat.tool_choice, undefined);
});

test("Responses validates and propagates top-level x_routekit reasoning controls", async () => {
  const valid = [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "effort", effort: "high" },
    { mode: "budget", budgetTokens: 2048 }
  ] as const;
  for (const selection of valid) {
    const chat = responsesToChat(
      { input: "hello", x_routekit: { version: 1, selection } },
      "model"
    );
    assert.deepEqual(reasoningSelectionOf(chat), selection);
    assert.deepEqual((chat.x_routekit as { selection?: unknown }).selection, selection);
  }

  const symbolBody: Record<PropertyKey, unknown> = { input: "hello" };
  attachReasoningSelection(symbolBody, { mode: "adaptive" });
  const symbolChat = responsesToChat(symbolBody, "model");
  assert.deepEqual(reasoningSelectionOf(symbolChat), { mode: "adaptive" });
});

test("Responses rejects malformed and conflicting reasoning controls before provider I/O", async () => {
  let calls = 0;
  const backend: import("../backend.js").Backend = {
    defaultModel: "openai/gpt-5.5",
    ports: borrowedBackendPorts("openai/gpt-5.5"),
    chat: () => {
      calls += 1;
      return Effect.succeed(Response.json({}));
    },
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  const gateway = await startGateway({ backend });
  try {
    const cases: Array<{ body: Record<string, unknown>; message: RegExp }> = [
      {
        body: {
          model: "openai/gpt-5.5",
          input: "hello",
          x_routekit: { version: 1, selection: { mode: "budget", budgetTokens: 0 } }
        },
        message: /budgetTokens must be a positive integer/
      },
      { body: { input: "hello", x_routekit: [] }, message: /x_routekit must be an object/ },
      {
        body: { input: "hello", x_routekit: { version: 2 } },
        message: /x_routekit.version must be 1/
      }
    ];
    for (const item of cases) {
      const response = await fetch(`${gateway.url()}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.body)
      });
      assert.equal(response.status, 400);
      const error = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(error.error.code, "invalid_reasoning_control");
      assert.match(error.error.message, item.message);
    }
    assert.equal(calls, 0);
  } finally {
    await Effect.runPromise(gateway.close);
  }
});

test("Responses canonical selection presence suppresses native effort", () => {
  const selections = [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "budget", budgetTokens: 2048 },
    { mode: "effort", effort: "canonical" }
  ] as const;
  for (const selection of selections) {
    const chat = responsesToChat(
      {
        input: "hello",
        reasoning: { effort: "native" },
        x_routekit: { version: 1, selection }
      },
      "model"
    );
    assert.deepEqual(reasoningSelectionOf(chat), selection);
    assert.equal(chat.reasoning_effort, undefined);
    assert.equal(reasoningSelectionErrorOf(chat), undefined);
  }
  const native = responsesToChat({ input: "hello", reasoning: { effort: "native" } }, "model");
  assert.deepEqual(reasoningSelectionOf(native), { mode: "effort", effort: "native" });
  assert.equal(native.reasoning_effort, "native");

  const symbolBody: Record<PropertyKey, unknown> = {
    input: "hello",
    reasoning: { effort: "native" }
  };
  attachReasoningSelection(symbolBody, { mode: "auto" });
  const symbolChat = responsesToChat(symbolBody, "model");
  assert.deepEqual(reasoningSelectionOf(symbolChat), { mode: "auto" });
  assert.equal(symbolChat.reasoning_effort, undefined);
});

test("responsesToChat preserves malformed envelope error before native effort mutation", () => {
  const chat = responsesToChat(
    {
      input: "hello",
      reasoning: { effort: "high" },
      x_routekit: { version: 1, selection: { mode: "future" } as never }
    },
    "model"
  );
  assert.match(reasoningSelectionErrorOf(chat) ?? "", /mode is unsupported/);
});
