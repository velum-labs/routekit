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
import { type Backend, borrowedBackendPorts, ModelRoutedBackend } from "../providers/backend.js";
import { OpenAiBackend } from "../providers/openai-backend.js";
import { MODEL_CALL_ID_HEADER } from "../observability/provenance.js";
import { AnthropicBackend, CodexResponsesBackend } from "../providers/backends.js";
import { RoutingBackend } from "../routing/router.js";
import { startGateway } from "../gateway-service.js";
import { testProviderSource } from "./provider-source-fixture.js";

/**
 * M3 coverage: the OpenAI Responses adapter (Codex) against a mock OpenAI
 * chat backend. Verifies request translation (instructions, input items,
 * function-call outputs, tools), the non-streaming `response` object, and the
 * streamed Responses event sequence.
 */

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
        res.write('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sendJson(res, 200, {
        id: "cmpl-2",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Final answer" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 6, completion_tokens: 2 }
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

function chatOnlyOpenAiBackend(baseUrl: string, defaultModel: string): Backend {
  const backend = new OpenAiBackend({ baseUrl, defaultModel });
  return {
    defaultModel,
    ports: borrowedBackendPorts(defaultModel),
    chat: (body, signal, options) => backend.chat(body, signal, options),
    models: (signal) => backend.models(signal),
    embeddings: (body, signal) => backend.embeddings(body, signal)
  };
}

// ---- custom (freeform) tool round-trip: Codex apply_patch ----

const PATCH = "*** Begin Patch\n*** Update File: a.md\n@@\n-old\n+new\n*** End Patch\n";

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

function chatChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

// Typed (nameless) tool declarations, verbatim shapes from Codex 0.142:
// `tool_search` is client-executed discovery; `web_search` is server-executed.
const TOOL_SEARCH_DECL = {
  type: "tool_search",
  execution: "client",
  description: "Searches over deferred tool metadata.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"]
  }
};

const WEB_SEARCH_DECL = { type: "web_search", external_web_access: false };

async function codexAliasBackend(sourceCalls: string[]): Promise<RoutingBackend> {
  return await runRouteKitEffect(
    RoutingBackend.create({
      config: {
        providers: { codex: {} },
        defaultModel: "codex/matrix-codex"
      },
      sources: {
        codex: testProviderSource({
          sourceId: "codex",
          discoverModels: () =>
            Effect.succeed([
              {
                id: "matrix-codex",
                metadata: {
                  architecture: {
                    inputModalities: ["text"],
                    outputModalities: ["text"]
                  },
                  supportedParameters: ["tools", "tool_choice"],
                  provenance: "route"
                }
              }
            ]),
          chat: (body: unknown) => {
            sourceCalls.push((body as { model: string }).model);
            return Effect.succeed(
              Response.json({
                id: "chatcmpl_codex_alias",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "CODEX_ALIAS_OK" },
                    finish_reason: "stop"
                  }
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 }
              })
            );
          },
          embeddings: () => Effect.succeed(Response.json({}))
        })
      }
    })
  );
}

export type { Mock };
export {
  chatChunk,
  chatOnlyOpenAiBackend,
  codexAliasBackend,
  PATCH,
  readAll,
  sendJson,
  sseStream,
  startMock,
  TOOL_SEARCH_DECL,
  WEB_SEARCH_DECL
};
