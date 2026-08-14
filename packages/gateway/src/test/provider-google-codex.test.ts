import assert from "node:assert/strict";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

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
import { OpenAiBackend } from "../openai-backend.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "../provider-backends.js";
import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import { SseDecoder, SseParseError } from "../sse/parse.js";

import { asTransport, sse } from "./provider-backends-fixtures.js";

test("Google GenAI egress maps content, usage, and API-key auth", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              { text: "answer" },
              { text: "must not leak", thought: "true", thoughtSignature: { bad: true } }
            ]
          }
        }
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 1,
        totalTokenCount: 4
      }
    });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await runRouteKitEffect(
      backend.chat({
        reasoning_effort: "deliberate",
        messages: [{ role: "user", content: "hello" }]
      })
    );
    assert.match(request?.url ?? "", /models\/gemini-test:generateContent$/);
    assert.equal(request?.headers.get("x-goog-api-key"), "google-secret");
    const outbound = (await request?.json()) as {
      generationConfig: { thinkingConfig: { thinkingLevel: string } };
    };
    assert.equal(outbound.generationConfig.thinkingConfig.thinkingLevel, "deliberate");
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "answer");
    assert.equal(body.usage.total_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google GenAI separates thoughts and replays signed continuation parts", async () => {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              { text: "private analysis", thought: true, thoughtSignature: "thought-sig" },
              { text: "visible answer" },
              {
                functionCall: { name: "search", args: { query: "routekit" } },
                thoughtSignature: "call-sig"
              }
            ]
          }
        }
      ]
    });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const first = await runRouteKitEffect(
      backend.chat({ messages: [{ role: "user", content: "solve" }] })
    );
    const payload = (await first.json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    const assistant = payload.choices[0]?.message as {
      content: string;
      reasoning: string;
      reasoning_details: Array<Record<string, unknown>>;
      tool_calls: Array<Record<string, unknown>>;
    };
    assert.equal(assistant.content, "visible answer");
    assert.equal(assistant.reasoning, "private analysis");
    assert.deepEqual(
      assistant.tool_calls.map((call) => (call as { index?: number }).index),
      [0],
      "OpenAI tool-call indexes are dense, independent of Google part position"
    );
    assert.deepEqual(assistant.reasoning_details, [
      {
        text: "private analysis",
        extensions: [
          {
            namespace: "google.reasoning",
            value: { index: 0, thoughtSignature: "thought-sig" }
          }
        ]
      },
      {
        extensions: [
          {
            namespace: "google.reasoning",
            value: { index: 2, thoughtSignature: "call-sig" }
          }
        ]
      }
    ]);

    await runRouteKitEffect(
      backend.chat({
        messages: [
          { role: "user", content: "solve" },
          assistant,
          {
            role: "tool",
            tool_call_id: (assistant.tool_calls[0] as { id: string }).id,
            content: "result"
          }
        ]
      })
    );
    const continuation = (await requests[1]?.json()) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    const replayed = continuation.contents.find((content) => content.role === "model")?.parts ?? [];
    assert.deepEqual(replayed, [
      { text: "private analysis", thought: true, thoughtSignature: "thought-sig" },
      { text: "visible answer" },
      {
        functionCall: { name: "search", args: { query: "routekit" } },
        thoughtSignature: "call-sig"
      }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google GenAI ignores malformed and unknown canonical thought metadata", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ candidates: [{ content: { parts: [{ text: "answer" }] } }] });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await runRouteKitEffect(
      backend.chat({
        messages: [
          {
            role: "assistant",
            content: "safe",
            reasoning_details: [
              { type: "google_thought", index: 0, thought: "secret", thoughtSignature: 42 },
              { type: "future_thought", index: 1, thoughtSignature: "unknown" }
            ]
          }
        ]
      })
    );
    const outbound = (await request?.json()) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(outbound.contents[0]?.parts, [{ text: "safe" }]);
    const payload = (await response.json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    assert.equal(payload.choices[0]?.message.content, "answer");
    assert.equal(payload.choices[0]?.message.reasoning, undefined);
    assert.equal(payload.choices[0]?.message.reasoning_details, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI native Responses egress normalizes long paired call ids immutably", async () => {
  const originalFetch = globalThis.fetch;
  let outbound: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ id: "resp_1", output: [] });
  };
  try {
    const longCallId = `call_${"native".repeat(20)}`;
    const call = { type: "function_call", call_id: longCallId, name: "read", arguments: "{}" };
    const output = { type: "function_call_output", call_id: longCallId, output: "source" };
    const body = { model: "m", input: [call, output], x_routekit: { version: 1 } };
    const backend = new OpenAiBackend({ baseUrl: "https://openai.test/v1" });

    await runRouteKitEffect(backend.responses(body));

    const items = outbound?.input as Array<{ call_id: string }>;
    assert.equal(items[0]?.call_id, items[1]?.call_id);
    assert.ok((items[0]?.call_id.length ?? Infinity) <= 64);
    assert.match(items[0]?.call_id ?? "", /^rk_/);
    assert.equal(outbound?.x_routekit, undefined);
    assert.equal(call.call_id, longCallId);
    assert.equal(output.call_id, longCallId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex Responses egress normalizes long tool call and output ids together", async () => {
  let outbound: Record<string, unknown> | undefined;
  const longCallId = `call_${"codex".repeat(20)}`;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test",
    transport: asTransport(async (_url, init) => {
      outbound = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      });
    })
  });

  await runRouteKitEffect(
    backend.chat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: longCallId, function: { name: "read", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: longCallId, content: "source" }
      ]
    })
  );

  const items = outbound?.input as Array<{ call_id: string }>;
  assert.equal(items[0]?.call_id, items[1]?.call_id);
  assert.ok((items[0]?.call_id.length ?? Infinity) <= 64);
  assert.match(items[0]?.call_id ?? "", /^rk_/);
});

test("Codex Responses egress replays encrypted reasoning and include around tool continuation", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
    });
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "codex-test"
    });
    const encrypted = wrapResponsesEncryptedContent("opaque", {
      provider: "codex",
      nativeModel: "codex-test"
    });
    const responseChat = responsesToChat(
      {
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: null,
            encrypted_content: encrypted
          },
          { type: "message", role: "assistant", content: "checking" },
          { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "source" }
        ],
        include: ["reasoning.encrypted_content"]
      },
      "codex-test"
    );
    await runRouteKitEffect(backend.chat(responseChat));
    const outbound = (await request?.json()) as {
      input: Array<Record<string, unknown>>;
      include?: string[];
    };
    assert.deepEqual(outbound.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(
      outbound.input.map((item) => item.type ?? item.role),
      ["reasoning", "assistant", "function_call", "function_call_output"]
    );
    assert.deepEqual(outbound.input[0], {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      content: null,
      encrypted_content: "opaque"
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex Responses egress drops foreign and legacy reasoning but keeps matching ownership", async () => {
  let outbound: Record<string, unknown> | undefined;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test",
    transport: asTransport(async (_url, init) => {
      outbound = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      });
    })
  });
  const matching = wrapResponsesEncryptedContent("matching-raw", {
    provider: "codex",
    nativeModel: "codex-test"
  });
  const foreign = wrapResponsesEncryptedContent("foreign-raw", {
    provider: "codex",
    nativeModel: "other-model"
  });
  const chat = responsesToChat(
    {
      input: [
        { type: "reasoning", encrypted_content: matching },
        { type: "reasoning", encrypted_content: foreign },
        { type: "reasoning", encrypted_content: "legacy-raw" },
        { type: "message", role: "assistant", content: "prior" }
      ],
      include: ["reasoning.encrypted_content"]
    },
    "codex-test"
  );

  await runRouteKitEffect(backend.chat(chat));
  const reasoning = (outbound?.input as Array<Record<string, unknown>>).filter(
    (item) => item.type === "reasoning"
  );
  assert.deepEqual(
    reasoning.map((item) => item.encrypted_content),
    ["matching-raw"]
  );
  assert.deepEqual(outbound?.include, ["reasoning.encrypted_content"]);
});

test("Codex buffered ingress wraps encrypted reasoning with provider ownership", async () => {
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test",
    transport: asTransport(async () =>
      Response.json({
        output: [
          { type: "reasoning", id: "rs_1", encrypted_content: "provider-raw", summary: [] },
          { type: "message", content: [{ type: "output_text", text: "done" }] }
        ]
      })
    )
  });
  const response = await runRouteKitEffect(
    backend.chat({
      model: "codex-test",
      messages: [{ role: "user", content: "continue" }]
    })
  );
  const payload = (await response.json()) as {
    choices: Array<{ message: Record<string, unknown> }>;
  };
  const item = responsesReasoningMetadataOf(payload.choices[0]?.message)?.items[0];
  assert.deepEqual(parseResponsesEncryptedContent(item?.encryptedContent), {
    owner: { provider: "codex", nativeModel: "codex-test" },
    ciphertext: "provider-raw"
  });
});

test("Codex streaming ingress wraps encrypted reasoning with provider ownership", async () => {
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test",
    transport: asTransport(async () =>
      sse([
        {
          event: "response.output_item.done",
          data: {
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "stream-provider-raw",
              summary: []
            }
          }
        },
        {
          event: "response.output_text.delta",
          data: { output_index: 1, delta: "done" }
        },
        {
          event: "response.completed",
          data: {
            response: {
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "done" }]
                }
              ]
            }
          }
        }
      ])
    )
  });
  const response = await runRouteKitEffect(
    backend.chat({
      model: "codex-test",
      stream: true,
      messages: [{ role: "user", content: "continue" }]
    })
  );
  const decoder = new SseDecoder();
  const events = [...decoder.feed(await response.text()), ...decoder.flush()];
  const reasoning = events.flatMap((event) => {
    if (event.data === "[DONE]") return [];
    const payload = JSON.parse(event.data) as {
      choices?: Array<{ delta?: Record<string, unknown> }>;
    };
    const metadata = responsesReasoningMetadataOf(payload.choices?.[0]?.delta);
    return metadata?.items ?? [];
  });
  assert.equal(reasoning.length, 1);
  assert.deepEqual(parseResponsesEncryptedContent(reasoning[0]?.encryptedContent), {
    owner: { provider: "codex", nativeModel: "codex-test" },
    ciphertext: "stream-provider-raw"
  });
});

test("Codex Responses egress preserves subscription auth and tool output", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "resp_1",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "considering the fix" }]
        },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "apply",
          arguments: '{"patch":"x"}'
        }
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
    });
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      accountId: "account",
      defaultModel: "codex-test"
    });
    const response = await runRouteKitEffect(
      backend.chat({
        reasoning_effort: "deep",
        messages: [{ role: "user", content: "fix it" }],
        tools: [{ type: "function", function: { name: "apply" } }]
      })
    );
    assert.equal(request?.url, "https://chatgpt.test/backend-api/codex/responses");
    assert.equal(request?.headers.get("authorization"), "Bearer oauth");
    assert.equal(request?.headers.get("chatgpt-account-id"), "account");
    const upstreamBody = (await request?.json()) as Record<string, unknown> | undefined;
    assert.equal(upstreamBody?.store, false);
    assert.deepEqual(upstreamBody?.reasoning, { effort: "deep" });
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string; reasoning: string; tool_calls: unknown[] };
      }>;
    };
    assert.equal(body.choices[0]?.message.content, "done");
    assert.equal(body.choices[0]?.message.reasoning, "considering the fix");
    assert.equal(body.choices[0]?.message.tool_calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress forces SSE and omits unsupported sampling", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "done" }]
              }
            ],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
          }
        }
      }
    ]);
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "codex-test",
      forceStream: true,
      omitSampling: true
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: false,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: "user", content: "reply" }]
      })
    );
    const outbound = (await request?.json()) as Record<string, unknown>;
    assert.equal(outbound.stream, true);
    assert.equal("max_output_tokens" in outbound, false);
    assert.equal("temperature" in outbound, false);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0]?.message.content, "done");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress recovers output from completed stream items", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.4-mini",
      forceStream: true,
      omitSampling: true
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: false,
        messages: [{ role: "user", content: "Say ok" }]
      })
    );
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { completion_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "ok");
    assert.equal(body.usage.completion_tokens, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress merges completed items into partial terminal output", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "brief reasoning" }]
          },
          output_index: 0
        }
      },
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "RouteKit works" }]
          },
          output_index: 1
        }
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "brief reasoning" }]
              }
            ],
            usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5",
      forceStream: true,
      omitSampling: true
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: false,
        messages: [{ role: "user", content: "Reply with: RouteKit works" }]
      })
    );
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string; reasoning: string };
      }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.choices[0]?.message.content, "RouteKit works");
    assert.equal(body.choices[0]?.message.reasoning, "brief reasoning");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming recovers text when only the completed item carries it", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "RouteKit works" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5",
      forceStream: true,
      omitSampling: true
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: true,
        messages: [{ role: "user", content: "Reply with: RouteKit works" }]
      })
    );
    const text = await response.text();
    assert.match(text, /"content":"RouteKit works"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /"completion_tokens":5/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming does not duplicate delta and completed-item text", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "response.output_text.delta",
        data: { output_index: 0, delta: "RouteKit " }
      },
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "RouteKit works" }]
          },
          output_index: 0
        }
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "RouteKit works" }]
              }
            ],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5"
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: true,
        messages: [{ role: "user", content: "Reply with: RouteKit works" }]
      })
    );
    const decoder = new SseDecoder();
    const events = [...decoder.feed(await response.text()), ...decoder.flush()];
    const assembler = new ChatStreamAssembler();
    for (const event of events) assembler.push(event);
    assert.equal(assembler.result().content, "RouteKit works");
    assert.equal(assembler.result().finishReason, "stop");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress rejects a silent reasoning-only completion", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "internal reasoning" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: {
              input_tokens: 22,
              output_tokens: 31,
              output_tokens_details: { reasoning_tokens: 22 },
              total_tokens: 53
            }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5",
      forceStream: true,
      omitSampling: true
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: false,
        messages: [{ role: "user", content: "Reply with: RouteKit works" }]
      })
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Codex completed without assistant content or tool calls",
        type: "upstream_empty_response"
      }
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming surfaces a silent reasoning-only completion as an error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "response.reasoning_summary_text.delta",
        data: { output_index: 0, delta: "internal reasoning" }
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [],
            usage: {
              input_tokens: 22,
              output_tokens: 31,
              output_tokens_details: { reasoning_tokens: 22 },
              total_tokens: 53
            }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5"
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: true,
        messages: [{ role: "user", content: "Reply with: RouteKit works" }]
      })
    );
    const text = await response.text();
    assert.match(text, /"type":"upstream_empty_response"/);
    assert.doesNotMatch(text, /"finish_reason":"stop"/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming surfaces terminal failure events", async () => {
  const original = globalThis.fetch;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "gpt-5.5"
  });
  try {
    for (const terminal of [
      { event: "response.failed", data: { response: { status: "failed" } } },
      {
        event: "response.incomplete",
        data: { response: { status: "incomplete" } }
      },
      {
        data: { type: "response.failed", response: { status: "failed" } }
      }
    ]) {
      globalThis.fetch = async () => sse([terminal]);
      const response = await runRouteKitEffect(
        backend.chat({
          stream: true,
          messages: [{ role: "user", content: "Reply with: RouteKit works" }]
        })
      );
      const text = await response.text();
      assert.match(text, /"type":"upstream_error"/);
      assert.doesNotMatch(text, /"finish_reason":"stop"/);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic streaming egress preserves tool calls and terminal usage", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse(
      [
        {
          event: "message_start",
          data: {
            message: { usage: { input_tokens: 4 } }
          }
        },
        {
          event: "content_block_start",
          data: {
            index: 0,
            content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} }
          }
        },
        {
          event: "content_block_delta",
          data: { index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } }
        },
        {
          event: "message_delta",
          data: {
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 2 }
          }
        }
      ],
      true
    );
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await runRouteKitEffect(
      backend.chat({
        stream: true,
        messages: [{ role: "user", content: "inspect" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
      })
    );
    const text = await response.text();
    assert.match(text, /"name":"read"/);
    assert.match(text, /\\"path\\":\\"a\.ts\\"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"input_tokens":4/);
    assert.match(text, /"output_tokens":2/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
