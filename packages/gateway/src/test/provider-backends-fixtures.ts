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

export { sse };
