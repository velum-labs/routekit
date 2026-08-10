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

test("Anthropic streaming egress preserves thinking lifecycle, signatures, and redactions", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse(
      [
        {
          event: "content_block_start",
          data: {
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" }
          }
        },
        {
          event: "content_block_delta",
          data: {
            index: 0,
            delta: { type: "thinking_delta", thinking: "native thought" }
          }
        },
        {
          event: "content_block_delta",
          data: {
            index: 0,
            delta: { type: "signature_delta", signature: "sig-stream" }
          }
        },
        { event: "content_block_stop", data: { index: 0 } },
        {
          event: "content_block_start",
          data: {
            index: 1,
            content_block: {
              type: "redacted_thinking",
              data: "opaque-stream"
            }
          }
        },
        { event: "content_block_stop", data: { index: 1 } },
        {
          event: "content_block_start",
          data: { index: 2, content_block: { type: "text", text: "" } }
        },
        {
          event: "content_block_delta",
          data: { index: 2, delta: { type: "text_delta", text: "answer" } }
        },
        { event: "content_block_stop", data: { index: 2 } },
        {
          event: "message_delta",
          data: {
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 4, output_tokens: 5 }
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
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "think" }]
    });
    const text = await response.text();
    assert.match(text, /"reasoning":"native thought"/);
    assert.match(text, /"phase":"start"/);
    assert.match(text, /"phase":"signature","signature":"sig-stream"/);
    assert.match(text, /"phase":"stop"/);
    assert.match(text, /"type":"redacted_thinking"/);
    assert.match(text, /"data":"opaque-stream"/);
    assert.match(text, /"content":"answer"/);
    assert.match(text, /"finish_reason":"stop"/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google streaming egress preserves function history, tools, and usage", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        data: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "stream thought", thought: true, thoughtSignature: "stream-thought-sig" },
                  { text: "stream answer" },
                  {
                    functionCall: { name: "search", args: { query: "routekit" } },
                    thoughtSignature: "stream-call-sig"
                  }
                ]
              },
              finishReason: "STOP"
            }
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }
      }
    ]);
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "search", arguments: '{"query":"first"}' }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "first result" }
      ],
      tools: [
        {
          type: "function",
          function: { name: "search", parameters: { type: "object" } }
        }
      ]
    });
    assert.match(request?.url ?? "", /models\/gemini-test:streamGenerateContent\?alt=sse$/);
    const outbound = (await request?.json()) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };
    assert.equal(outbound.tools[0]?.functionDeclarations[0]?.name, "search");
    assert.ok(
      outbound.contents.some((content) => content.parts.some((part) => "functionCall" in part))
    );
    assert.ok(
      outbound.contents.some((content) => content.parts.some((part) => "functionResponse" in part))
    );
    const text = await response.text();
    assert.match(text, /"reasoning":"stream thought"/);
    assert.match(text, /"content":"stream answer"/);
    assert.match(text, /"type":"google_thought"/);
    assert.match(text, /"thoughtSignature":"stream-thought-sig"/);
    assert.match(text, /"thoughtSignature":"stream-call-sig"/);
    assert.match(text, /"name":"search"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /"total_tokens":6/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google streaming assigns stable indexes across restarting local part arrays", async () => {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  let invocation = 0;
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    invocation += 1;
    if (invocation === 1) {
      return sse([
        { data: { candidates: [{ content: { parts: [{ text: "think ", thought: true }] } }] } },
        {
          data: {
            candidates: [
              {
                content: {
                  parts: [{ text: "carefully", thought: true, thoughtSignature: "thought-sig" }]
                }
              }
            ]
          }
        },
        { data: { candidates: [{ content: { parts: [{ text: "visible answer" }] } }] } },
        {
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: "web_search", args: { query: "routekit" } },
                      thoughtSignature: "call-sig"
                    }
                  ]
                }
              }
            ]
          }
        },
        {
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "compare alternatives",
                      thought: true,
                      thoughtSignature: "second-thought-sig"
                    }
                  ]
                }
              }
            ]
          }
        },
        {
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: "web_search", args: { query: "routekit" } },
                      thoughtSignature: "second-call-sig"
                    }
                  ]
                },
                finishReason: "STOP"
              }
            ]
          }
        }
      ]);
    }
    return sse([
      {
        data: {
          candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }]
        }
      }
    ]);
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const first = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "solve" }],
      tools: [
        {
          type: "function",
          function: { name: "web_search", parameters: { type: "object" } }
        }
      ]
    });
    const assembler = new ChatStreamAssembler();
    for (const event of new SseDecoder().feed(new TextEncoder().encode(await first.text()))) {
      assembler.push(event);
    }
    const turn = assembler.result();
    assert.equal(turn.reasoning, "think carefullycompare alternatives");
    assert.deepEqual(turn.reasoningDetails, [
      {
        type: "google_thought",
        index: 0,
        thought: "think carefully",
        thoughtSignature: "thought-sig"
      },
      { type: "google_thought", index: 2, thoughtSignature: "call-sig" },
      {
        type: "google_thought",
        index: 3,
        thought: "compare alternatives",
        thoughtSignature: "second-thought-sig"
      },
      { type: "google_thought", index: 4, thoughtSignature: "second-call-sig" }
    ]);
    assert.equal(turn.toolCalls.length, 2);
    assert.deepEqual(
      turn.toolCalls.map((call) => call.index),
      [0, 1]
    );
    assert.deepEqual(
      turn.toolCalls.map((call) => call.name),
      ["web_search", "web_search"]
    );
    assert.deepEqual(
      turn.toolCalls.map((call) => call.providerIndex),
      [2, 4]
    );

    await backend.chat({
      stream: true,
      messages: [
        { role: "user", content: "solve" },
        (() => {
          const assistant: Record<PropertyKey, unknown> = {
            role: "assistant",
            content: turn.content,
            reasoning_details: turn.reasoningDetails,
            tool_calls: turn.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments }
            }))
          };
          attachGoogleToolCallIndexes(
            assistant,
            Object.fromEntries(
              turn.toolCalls.flatMap((call) =>
                call.id !== undefined && call.providerIndex !== undefined
                  ? [[call.id, call.providerIndex]]
                  : []
              )
            )
          );
          return assistant;
        })(),
        { role: "tool", tool_call_id: turn.toolCalls[0]?.id, content: "first result" },
        { role: "tool", tool_call_id: turn.toolCalls[1]?.id, content: "second result" }
      ]
    });
    const continuation = (await requests[1]?.json()) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    const replayed = continuation.contents.find((entry) => entry.role === "model")?.parts ?? [];
    assert.deepEqual(replayed, [
      { text: "think carefully", thought: true, thoughtSignature: "thought-sig" },
      { text: "visible answer" },
      {
        functionCall: { name: "web_search", args: { query: "routekit" } },
        thoughtSignature: "call-sig"
      },
      {
        text: "compare alternatives",
        thought: true,
        thoughtSignature: "second-thought-sig"
      },
      {
        functionCall: { name: "web_search", args: { query: "routekit" } },
        thoughtSignature: "second-call-sig"
      }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex streaming egress preserves Responses tool history and deltas", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        event: "response.reasoning_summary_text.delta",
        data: { delta: "considering the patch" }
      },
      {
        event: "response.output_item.added",
        data: {
          output_index: 0,
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_2",
            name: "apply"
          }
        }
      },
      {
        event: "response.function_call_arguments.delta",
        data: { output_index: 0, delta: '{"patch":"x"}' }
      },
      {
        event: "response.completed",
        data: {
          response: {
            usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 }
          }
        }
      }
    ]);
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      accountId: "account",
      defaultModel: "codex-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "read", arguments: '{"path":"a.ts"}' }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "source" }
      ],
      tools: [
        {
          type: "function",
          function: { name: "apply", parameters: { type: "object" } }
        }
      ]
    });
    const outbound = (await request?.json()) as {
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    assert.ok(outbound.input.some((item) => item.type === "function_call"));
    assert.ok(outbound.input.some((item) => item.type === "function_call_output"));
    assert.deepEqual(outbound.tools[0], {
      type: "function",
      name: "apply",
      parameters: { type: "object" }
    });
    const text = await response.text();
    assert.match(text, /"reasoning":"considering the patch"/);
    assert.match(text, /"name":"apply"/);
    assert.match(text, /\\"patch\\":\\"x\\"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"total_tokens":9/);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider streaming surfaces malformed and truncated SSE", async () => {
  const original = globalThis.fetch;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test"
  });
  try {
    for (const body of [
      "event: response.output_text.delta\ndata: {malformed}\n\n",
      'event: response.output_text.delta\ndata: {"delta":"partial"}'
    ]) {
      globalThis.fetch = async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" }
        });
      const response = await backend.chat({
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      });
      await assert.rejects(response.text(), SseParseError);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("ordinary OpenAI Chat egress strips RouteKit provider-only envelopes", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  try {
    const backend = new OpenAiBackend({
      baseUrl: "https://api.openai.test/v1",
      apiKey: "secret",
      defaultModel: "gpt-test"
    });
    await backend.chat({
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          x_routekit: {
            version: 1,
            anthropic: {
              content: [{ type: "thinking", thinking: "private", signature: "sig" }]
            }
          }
        }
      ],
      x_routekit: {
        version: 1,
        selection: { mode: "effort", effort: "high" },
        anthropic: {
          request: {
            thinking: { type: "adaptive" },
            output_config: { effort: "high" }
          }
        }
      }
    });
    const outbound = (await request?.json()) as {
      x_routekit?: unknown;
      messages?: Array<{ x_routekit?: unknown }>;
    };
    assert.equal(outbound.x_routekit, undefined);
    assert.equal(outbound.messages?.[0]?.x_routekit, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex backend preserves structured forced-stream terminal failure", async () => {
  const backend = new CodexResponsesBackend({
    baseUrl: "https://codex.test",
    apiKey: "x",
    defaultModel: "m",
    forceStream: true,
    transport: async () =>
      sse([
        {
          event: "response.failed",
          data: {
            response: {
              error: {
                type: "usage_limit_reached",
                code: "weekly",
                message: "spent",
                resets_at: 1775000000
              }
            }
          }
        }
      ])
  });
  const response = await backend.chat({ model: "m", messages: [] });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      type: "usage_limit_reached",
      code: "weekly",
      message: "spent",
      resets_at: 1775000000
    }
  });
});

test("Codex streaming backend preserves terminal provider error fields", async () => {
  const backend = new CodexResponsesBackend({
    baseUrl: "https://codex.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async () =>
      sse([
        {
          event: "response.failed",
          data: {
            response: {
              error: {
                type: "usage_limit_reached",
                code: "weekly",
                message: "spent",
                resets_at: 1775000000
              }
            }
          }
        }
      ])
  });
  const text = await (await backend.chat({ model: "m", messages: [], stream: true })).text();
  assert.match(text, /usage_limit_reached/);
  assert.match(text, /weekly/);
  assert.match(text, /1775000000/);
});
