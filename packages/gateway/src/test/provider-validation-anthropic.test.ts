import assert from "node:assert/strict";

import { test } from "node:test";
import { anthropicToChat } from "../adapters/anthropic.js";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  ANTHROPIC_REQUEST_METADATA,
  attachGoogleToolCallIndexes,
  attachReasoningSelection,
  REASONING_SELECTION,
  responsesReasoningMetadataOf
} from "../adapters/openai-chat-wire.js";
import {
  parseResponsesEncryptedContent,
  wrapResponsesEncryptedContent
} from "../adapters/openai-responses-wire.js";
import { responsesToChat } from "../adapters/responses.js";
import { OpenAiBackend } from "../backend.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "../provider-backends.js";
import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import { SseDecoder, SseParseError } from "../sse/parse.js";

import { sse } from "./provider-backends-fixtures.js";

test("direct provider backends reject malformed reasoning controls before transport", async () => {
  const cases = [
    {
      name: "openai",
      make: (transport: typeof globalThis.fetch) => {
        const original = globalThis.fetch;
        globalThis.fetch = transport;
        return {
          backend: new OpenAiBackend({ baseUrl: "https://openai.test/v1", defaultModel: "m" }),
          restore: () => {
            globalThis.fetch = original;
          }
        };
      }
    },
    {
      name: "anthropic",
      make: (transport: typeof globalThis.fetch) => ({
        backend: new AnthropicBackend({
          baseUrl: "https://anthropic.test",
          apiKey: "x",
          defaultModel: "m",
          transport
        }),
        restore: () => {}
      })
    },
    {
      name: "google",
      make: (transport: typeof globalThis.fetch) => ({
        backend: new GoogleGenAiBackend({
          baseUrl: "https://google.test",
          apiKey: "x",
          defaultModel: "m",
          transport
        }),
        restore: () => {}
      })
    },
    {
      name: "codex",
      make: (transport: typeof globalThis.fetch) => ({
        backend: new CodexResponsesBackend({
          baseUrl: "https://codex.test",
          apiKey: "x",
          defaultModel: "m",
          transport
        }),
        restore: () => {}
      })
    }
  ];
  for (const item of cases) {
    let calls = 0;
    const transport: typeof globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const { backend, restore } = item.make(transport);
    try {
      for (const body of [
        { model: "m", messages: [], x_routekit: { version: 1, selection: { mode: "future" } } },
        { model: "m", messages: [], reasoning_effort: "" },
        {
          model: "m",
          messages: [],
          x_routekit: { version: 1, responses: { items: [null], includeEncryptedContent: true } }
        },
        {
          model: "m",
          messages: [],
          x_routekit: {
            version: 1,
            anthropic: { request: { thinking: { type: "enabled", budget_tokens: 0 } } }
          }
        },
        {
          model: "m",
          messages: [],
          x_routekit: {
            version: 1,
            selection: { mode: "disabled" },
            anthropic: { request: { thinking: { type: "adaptive" } } }
          }
        },
        {
          model: "m",
          messages: [],
          x_routekit: {
            version: 1,
            selection: { mode: "budget", budgetTokens: 1024 },
            anthropic: { request: { thinking: { type: "enabled", budget_tokens: 2048 } } }
          }
        },
        {
          model: "m",
          messages: [],
          x_routekit: {
            version: 1,
            selection: { mode: "effort", effort: "high" },
            anthropic: {
              request: { thinking: { type: "adaptive" }, output_config: { effort: "low" } }
            }
          }
        },
        {
          model: "m",
          messages: [],
          x_routekit: {
            version: 1,
            selection: { mode: "adaptive" },
            anthropic: {
              request: { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
            }
          }
        },
        {
          model: "m",
          messages: [
            {
              role: "assistant",
              content: "x",
              x_routekit: {
                version: 1,
                responses: { items: [null], includeEncryptedContent: true }
              }
            }
          ]
        },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: [] }] },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: { version: 2 } }] },
        {
          model: "m",
          messages: [
            {
              role: "assistant",
              content: "x",
              x_routekit: { version: 1, google: { toolCallIndexes: { call_1: "two" } } }
            }
          ]
        },
        {
          model: "m",
          messages: [
            {
              role: "assistant",
              content: "x",
              x_routekit: { version: 1, anthropic: { content: [null] } }
            }
          ]
        }
      ]) {
        const response = await backend.chat(body);
        assert.equal(response.status, 400, item.name);
        const error = (await response.json()) as { error: { code?: string } };
        assert.ok(
          error.error.code === "invalid_reasoning_control" ||
            error.error.code === "invalid_reasoning_metadata",
          item.name
        );
      }
      const symbolBody: Record<PropertyKey, unknown> = { model: "m", messages: [] };
      Object.defineProperty(symbolBody, REASONING_SELECTION, {
        value: { mode: "budget", budgetTokens: 0 },
        enumerable: true
      });
      const symbolResponse = await backend.chat(symbolBody);
      assert.equal(symbolResponse.status, 400, item.name);
      assert.equal(calls, 0, `${item.name} transport must not run`);
    } finally {
      restore();
    }
  }
});

test("direct provider backends reject malformed Anthropic metadata before transport", async () => {
  const malformedRequests: unknown[] = [
    { thinking: "enabled" },
    { thinking: { type: "enabled" } },
    { thinking: { type: "enabled", budget_tokens: 0 } },
    { thinking: { type: "enabled", budget_tokens: 1.5 } },
    { thinking: { type: "adaptive", display: "full" } },
    { thinking: { type: "disabled", budget_tokens: 1024 } },
    { thinking: { type: "disabled", display: null } },
    { output_config: [] },
    { output_config: { effort: "" } }
  ];
  const malformedBlocks: unknown[] = [
    null,
    { type: "text", text: 1 },
    { type: "thinking", thinking: 1, signature: "sig" },
    { type: "thinking", thinking: "private", signature: "" },
    { type: "redacted_thinking", data: "" },
    { type: "tool_use", id: "", name: "read", input: {} },
    { type: "tool_use", id: "tool_1", name: "", input: {} },
    { type: "tool_use", id: "tool_1", name: "read" }
  ];
  let calls = 0;
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async () => {
      calls += 1;
      return Response.json({ content: [], usage: {} });
    }
  });
  for (const request of malformedRequests) {
    const response = await backend.chat({
      model: "m",
      messages: [],
      x_routekit: { version: 1, anthropic: { request } }
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.match(error.error.param ?? "", /^x_routekit\.anthropic\.request/);
  }
  for (const block of malformedBlocks) {
    const response = await backend.chat({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "prior",
          x_routekit: { version: 1, anthropic: { content: [block] } }
        }
      ]
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.match(error.error.param ?? "", /^messages\[0\]\.x_routekit\.anthropic\.content/);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicResponse = await backend.chat({
    model: "m",
    messages: [],
    x_routekit: { version: 1, anthropic: { request: { output_config: { future: cyclic } } } }
  });
  assert.equal(cyclicResponse.status, 400);

  const symbolRequest: Record<PropertyKey, unknown> = { model: "m", messages: [] };
  Object.defineProperty(symbolRequest, ANTHROPIC_REQUEST_METADATA, {
    value: { thinking: { type: "enabled", budget_tokens: 0 } },
    enumerable: true
  });
  assert.equal((await backend.chat(symbolRequest)).status, 400);
  const symbolMessage: Record<PropertyKey, unknown> = { role: "assistant", content: "prior" };
  Object.defineProperty(symbolMessage, ANTHROPIC_MESSAGE_CONTENT, {
    value: [{ type: "thinking", thinking: "private", signature: "" }],
    enumerable: true
  });
  assert.equal((await backend.chat({ model: "m", messages: [symbolMessage] })).status, 400);
  const accessorRequest: Record<PropertyKey, unknown> = { model: "m", messages: [] };
  Object.defineProperty(accessorRequest, ANTHROPIC_REQUEST_METADATA, {
    get: () => {
      throw new Error("must not execute");
    },
    enumerable: true
  });
  assert.equal((await backend.chat(accessorRequest)).status, 400);
  assert.equal(calls, 0, "Anthropic transport must not run for malformed metadata");
});

test("Anthropic native and canonical reasoning controls require exact semantic agreement", async () => {
  const conflicting = [
    {
      selection: { mode: "disabled" },
      request: { thinking: { type: "enabled", budget_tokens: 1024 } }
    },
    { selection: { mode: "disabled" }, request: { thinking: { type: "adaptive" } } },
    {
      selection: { mode: "budget", budgetTokens: 1024 },
      request: { thinking: { type: "enabled", budget_tokens: 2048 } }
    },
    {
      selection: { mode: "effort", effort: "high" },
      request: { thinking: { type: "adaptive" }, output_config: { effort: "low" } }
    },
    {
      selection: { mode: "adaptive" },
      request: { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
    },
    { selection: { mode: "auto" }, request: { thinking: { type: "disabled" } } }
  ];
  const matching = [
    { selection: { mode: "disabled" }, request: { thinking: { type: "disabled" } } },
    { selection: { mode: "adaptive" }, request: { thinking: { type: "adaptive" } } },
    {
      selection: { mode: "budget", budgetTokens: 1024 },
      request: { thinking: { type: "enabled", budget_tokens: 1024 } }
    },
    {
      selection: { mode: "effort", effort: "high" },
      request: { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
    },
    {
      selection: { mode: "effort", effort: "high" },
      request: {
        thinking: { type: "enabled", budget_tokens: 1024 },
        output_config: { effort: "high" }
      }
    }
  ];
  let calls = 0;
  const outbound: Record<string, unknown>[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async (_url, init) => {
      calls += 1;
      outbound.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: "msg", content: [{ type: "text", text: "ok" }], usage: {} });
    }
  });
  for (const item of conflicting) {
    const response = await backend.chat({
      model: "m",
      max_tokens: 4096,
      messages: [],
      x_routekit: { version: 1, selection: item.selection, anthropic: { request: item.request } }
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_control");
    assert.equal(error.error.param, "x_routekit.anthropic.request");
  }
  assert.equal(calls, 0);
  for (const item of matching) {
    const response = await backend.chat({
      model: "m",
      max_tokens: 4096,
      messages: [{ role: "user", content: "go" }],
      x_routekit: { version: 1, selection: item.selection, anthropic: { request: item.request } }
    });
    assert.equal(response.status, 200);
  }
  assert.equal(calls, matching.length);
  assert.deepEqual(
    outbound.map((body) => ({ thinking: body.thinking, output_config: body.output_config })),
    matching.map((item) => ({
      thinking: item.request.thinking,
      output_config: "output_config" in item.request ? item.request.output_config : undefined
    }))
  );

  const symbolBody: Record<PropertyKey, unknown> = { model: "m", messages: [] };
  Object.defineProperty(symbolBody, REASONING_SELECTION, {
    value: { mode: "budget", budgetTokens: 1024 },
    enumerable: true
  });
  Object.defineProperty(symbolBody, ANTHROPIC_REQUEST_METADATA, {
    value: { thinking: { type: "enabled", budget_tokens: 2048 } },
    enumerable: true
  });
  const symbolResponse = await backend.chat(symbolBody);
  assert.equal(symbolResponse.status, 400);
  const symbolError = (await symbolResponse.json()) as { error: { code?: string; param?: string } };
  assert.equal(symbolError.error.code, "invalid_reasoning_control");
  assert.equal(symbolError.error.param, "x_routekit.anthropic.request");
  assert.equal(calls, matching.length);
});

test("canonical reasoning selection suppresses deprecated reasoning_effort", async () => {
  const canonical = [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "budget", budgetTokens: 1024 },
    { mode: "effort", effort: "high" }
  ];
  let calls = 0;
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async () => {
      calls += 1;
      return Response.json({ content: [], usage: {} });
    }
  });
  for (const selection of canonical) {
    const response = await backend.chat({
      model: "m",
      max_tokens: 4096,
      messages: [{ role: "user", content: "go" }],
      reasoning_effort: "legacy-conflict",
      x_routekit: { version: 1, selection }
    });
    assert.equal(response.status, 200, selection.mode);
  }
  assert.equal(calls, canonical.length);

  const nativeConflict = await backend.chat({
    model: "m",
    messages: [],
    reasoning_effort: "low",
    x_routekit: {
      version: 1,
      anthropic: {
        request: {
          thinking: { type: "adaptive" },
          output_config: { effort: "high" }
        }
      }
    }
  });
  assert.equal(nativeConflict.status, 400);
  const error = (await nativeConflict.json()) as { error: { code?: string; param?: string } };
  assert.equal(error.error.code, "invalid_reasoning_control");
  assert.equal(error.error.param, "reasoning_effort");
  assert.equal(calls, canonical.length);
});

test("Anthropic output effort requires compatible thinking", async () => {
  let calls = 0;
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async () => {
      calls += 1;
      return Response.json({ content: [], usage: {} });
    }
  });
  for (const request of [
    { output_config: { effort: "high" } },
    { thinking: { type: "disabled" }, output_config: { effort: "high" } }
  ]) {
    const response = await backend.chat({
      model: "m",
      messages: [],
      x_routekit: { version: 1, anthropic: { request } }
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.equal(error.error.param, "x_routekit.anthropic.request.output_config.effort");
  }
  assert.equal(calls, 0);
});

test("Anthropic metadata variants and future JSON-safe fields egress exactly", async () => {
  const outbound: Record<string, unknown>[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async (_url, init) => {
      outbound.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: "msg", content: [{ type: "text", text: "ok" }], usage: {} });
    }
  });
  const requests = [
    {
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
        display: "summarized",
        future: { nested: [true, null] }
      },
      output_config: { effort: "high", future: 1 }
    },
    { thinking: { type: "adaptive", display: "omitted" }, output_config: null },
    { thinking: { type: "disabled" } }
  ];
  for (const request of requests) {
    const response = await backend.chat({
      model: "m",
      max_tokens: 4096,
      messages:
        request === requests[0]
          ? [
              { role: "user", content: "go" },
              {
                role: "assistant",
                content: "prior",
                x_routekit: {
                  version: 1,
                  anthropic: { content: [{ type: "future_block", payload: { safe: true } }] }
                }
              }
            ]
          : [{ role: "user", content: "go" }],
      x_routekit: { version: 1, anthropic: { request } }
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    (outbound[0]?.messages as Array<{ content: unknown[] }> | undefined)?.[1]?.content,
    [{ type: "future_block", payload: { safe: true } }]
  );
  assert.deepEqual(
    outbound.map((body) => ({ thinking: body.thinking, output_config: body.output_config })),
    [
      { thinking: requests[0]?.thinking, output_config: requests[0]?.output_config },
      { thinking: requests[1]?.thinking, output_config: undefined },
      { thinking: requests[2]?.thinking, output_config: undefined }
    ]
  );
});

test("direct provider backends preserve valid reasoning controls", async () => {
  let openAiBody: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    openAiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  try {
    const openai = new OpenAiBackend({ baseUrl: "https://openai.test/v1", defaultModel: "m" });
    const response = await openai.chat({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "prior",
          x_routekit: {
            version: 1,
            responses: {
              items: [{ type: "reasoning", encrypted_content: "opaque" }],
              includeEncryptedContent: true
            },
            google: { toolCallIndexes: { call_1: 2 } },
            anthropic: { content: [{ type: "thinking", thinking: "private", signature: "sig" }] },
            future: { retained: true }
          }
        }
      ],
      x_routekit: { version: 1, selection: { mode: "effort", effort: "high" } }
    });
    assert.equal(response.status, 200);
    assert.equal(openAiBody?.x_routekit, undefined, "provider boundary strips RouteKit metadata");
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress preserves tools and normalizes the response", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_1",
      content: [
        { type: "text", text: "working" },
        { type: "tool_use", id: "tool_1", name: "read", input: { path: "a.ts" } }
      ],
      usage: { input_tokens: 4, output_tokens: 2 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await backend.chat({
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "read a file",
            parameters: { type: "object" }
          }
        }
      ]
    });
    assert.equal(request?.url, "https://api.anthropic.test/v1/messages");
    assert.equal(request?.headers.get("x-api-key"), "secret");
    const outbound = (await request?.json()) as {
      tools: Array<{ name: string }>;
    };
    assert.equal(outbound.tools[0]?.name, "read");
    const body = (await response.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
      usage: { input_tokens: number };
    };
    assert.equal(body.choices[0]?.message.tool_calls[0]?.function.name, "read");
    assert.equal(body.usage.input_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress drops blank turns and translates image parts", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_blank",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    await backend.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "" },
        { role: "user", content: [] },
        { role: "user", content: null },
        { role: "user", content: "   " },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }]
        }
      ]
    });
    const outbound = (await request?.json()) as {
      system: string;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(outbound.system, "be brief");
    assert.deepEqual(
      outbound.messages.map((message) => message.role),
      ["user", "assistant", "user"]
    );
    assert.ok(outbound.messages.every((message) => message.content.length > 0));
    assert.deepEqual(outbound.messages[2]?.content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress keeps a closing user turn when the caller's is blank", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_closing",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    await backend.chat({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "" }
      ]
    });
    const outbound = (await request?.json()) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(
      outbound.messages.map((message) => message.role),
      ["user", "assistant", "user"]
    );
    assert.equal(outbound.messages[2]?.content[0]?.type, "text");
    assert.ok(String(outbound.messages[2]?.content[0]?.text).trim().length > 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress keeps tool calls on assistant turns without text", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_tools",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    await backend.chat({
      messages: [
        { role: "user", content: "read a.ts" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"a.ts"}' } }]
        },
        { role: "tool", tool_call_id: "call_1", content: "" }
      ]
    });
    const outbound = (await request?.json()) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(
      outbound.messages.map((message) => message.content[0]?.type),
      ["text", "tool_use", "tool_result"]
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress preserves native thinking controls, signed history, and buffered blocks", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_think",
      content: [
        {
          type: "thinking",
          thinking: "native thought",
          signature: "sig-response"
        },
        { type: "redacted_thinking", data: "opaque-redaction" },
        {
          type: "tool_use",
          id: "tool_2",
          name: "read",
          input: { path: "b.ts" }
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 5 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const chat = anthropicToChat(
      {
        model: "claude-test",
        max_tokens: 4096,
        thinking: {
          type: "enabled",
          budget_tokens: 2048,
          display: "summarized"
        },
        output_config: { effort: "high" },
        messages: [
          { role: "user", content: "inspect" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "prior thought",
                signature: "sig-prior"
              },
              { type: "redacted_thinking", data: "prior-redaction" },
              {
                type: "tool_use",
                id: "tool_1",
                name: "read",
                input: { path: "a.ts" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: "source"
              }
            ]
          }
        ],
        tools: [
          {
            name: "read",
            input_schema: { type: "object" }
          }
        ],
        tool_choice: { type: "tool", name: "read", disable_parallel_tool_use: true }
      },
      "claude-test"
    );
    const response = await backend.chat(chat);
    const outbound = (await request?.json()) as {
      max_tokens: number;
      thinking: Record<string, unknown>;
      output_config: Record<string, unknown>;
      tool_choice: Record<string, unknown>;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(outbound.max_tokens, 4096);
    assert.deepEqual(outbound.thinking, {
      type: "enabled",
      budget_tokens: 2048,
      display: "summarized"
    });
    assert.deepEqual(outbound.output_config, { effort: "high" });
    assert.deepEqual(outbound.tool_choice, {
      type: "tool",
      name: "read",
      disable_parallel_tool_use: true
    });
    assert.deepEqual(
      outbound.messages[1]?.content.map((block) => block.type),
      ["thinking", "redacted_thinking", "tool_use"]
    );
    assert.equal(outbound.messages[1]?.content[0]?.signature, "sig-prior");

    const normalized = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          reasoning: string;
          reasoning_details: Array<Record<string, unknown>>;
        };
      }>;
    };
    assert.equal(normalized.choices[0]?.finish_reason, "tool_calls");
    assert.equal(normalized.choices[0]?.message.content, null);
    assert.equal(normalized.choices[0]?.message.reasoning, "native thought");
    assert.deepEqual(
      normalized.choices[0]?.message.reasoning_details.map((detail) => detail.type),
      ["thinking", "redacted_thinking"]
    );
    assert.equal(normalized.choices[0]?.message.reasoning_details[0]?.signature, "sig-response");
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress preserves opaque effort and rejects impossible explicit budgets", async () => {
  const requests: Request[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn"
      });
    }
  });
  const valid = await backend.chat({
    max_completion_tokens: 5000,
    reasoning_effort: "ultra",
    messages: [{ role: "user", content: "think" }]
  });
  assert.equal(valid.status, 200);
  const outbound = (await requests[0]?.json()) as {
    max_tokens: number;
    thinking: { type: string };
    output_config: { effort: string };
  };
  assert.equal(outbound.max_tokens, 5000);
  assert.deepEqual(outbound.thinking, { type: "adaptive" });
  assert.deepEqual(outbound.output_config, { effort: "ultra" });

  const invalidBody: Record<PropertyKey, unknown> = {
    max_completion_tokens: 1024,
    messages: [{ role: "user", content: "think" }]
  };
  attachReasoningSelection(invalidBody, {
    mode: "budget",
    budgetTokens: 1024
  });
  const invalid = await backend.chat(invalidBody);
  assert.equal(invalid.status, 400);
  assert.equal(requests.length, 1, "invalid thinking must fail before transport");
  assert.match(await invalid.text(), /less than max_tokens/);
});

test("Anthropic egress preserves native stop reasons and stop sequences", async () => {
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async () =>
      Response.json({
        content: [{ type: "text", text: "bounded" }],
        stop_reason: "stop_sequence",
        stop_sequence: "<END>"
      })
  });
  const response = await backend.chat({
    messages: [{ role: "user", content: "bounded answer" }]
  });
  const canonical = (await response.json()) as {
    choices: Array<Record<string, unknown>>;
  };
  assert.equal(canonical.choices[0]?.finish_reason, "stop");
  assert.equal(canonical.choices[0]?.anthropic_stop_reason, "stop_sequence");
  assert.equal(canonical.choices[0]?.anthropic_stop_sequence, "<END>");
});

test("Anthropic egress replays signed canonical reasoning_details from OpenAI clients", async () => {
  let request: Request | undefined;
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn"
      });
    }
  });
  await backend.chat({
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning: "prior",
        reasoning_details: [
          {
            type: "thinking",
            index: 0,
            thinking: "prior",
            signature: "sig-canonical"
          }
        ],
        tool_calls: [
          {
            id: "tool_1",
            function: { name: "read", arguments: '{"path":"a.ts"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool_1", content: "source" }
    ]
  });
  const outbound = (await request?.json()) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(
    outbound.messages[0]?.content.map((block) => block.type),
    ["thinking", "tool_use"]
  );
  assert.equal(outbound.messages[0]?.content[0]?.signature, "sig-canonical");
});
