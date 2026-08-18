import assert from "node:assert/strict";

import { test } from "node:test";
import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
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
import { OpenAiBackend } from "../providers/openai-backend.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend,
  type ProviderTransport
} from "../providers/backends.js";
import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import { SseDecoder, SseParseError } from "../sse/parse.js";

function sse(events: readonly { event?: string; data: unknown }[], includeDone = false): Response {
  const body =
    events
      .map(
        ({ event, data }) =>
          `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
      )
      .join("") + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" }
  });
}

export function asTransport(
  fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>
): ProviderTransport {
  return (url, init) =>
    Effect.tryPromise({
      try: async () => await fetchImpl(url, init),
      catch: (cause) => toRouteKitFailure(cause)
    });
}

export { sse };
