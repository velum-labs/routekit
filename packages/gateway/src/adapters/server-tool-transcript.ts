/**
 * How a gateway-executed server-tool exchange is written onto the OpenAI chat
 * transcript so Anthropic, Google, and Responses lossless metadata survives
 * the synthetic tool turn. Loop orchestration lives in `server-tool-loop.ts`.
 */

import type { Reasoning } from "@velum-labs/routekit-contracts/protocol-ir";
import { randomId } from "@velum-labs/routekit-runtime/timing";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  type AnthropicNativeContentBlock,
  anthropicReasoningDetailsOf,
  anthropicReasoningExtension,
  attachGoogleToolCallIndexes,
  attachResponsesReasoningMetadata,
  googleThoughtDetailsOf,
  type ResponsesReasoningState,
  reasoningIndex
} from "./openai-chat-wire.js";

export type ServerToolTranscriptCall = {
  providerIndex?: number;
  id?: string;
  name?: string;
  arguments?: string;
};

export type ServerToolTranscriptToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export function canonicalServerToolReasoning(
  details: readonly Reasoning[] | undefined
): Reasoning[] {
  return [
    ...anthropicReasoningDetailsOf(details, "message"),
    ...googleThoughtDetailsOf(details)
  ].sort((a, b) => reasoningIndex(a) - reasoningIndex(b));
}

export function nativeAnthropicServerToolReasoning(canonical: readonly Reasoning[]): Reasoning[] {
  return anthropicReasoningDetailsOf(canonical, "message")
    .filter((detail) => {
      const metadata = anthropicReasoningExtension(detail);
      return (
        metadata?.redacted === true ||
        (typeof metadata?.signature === "string" && metadata.signature.length > 0)
      );
    })
    .sort((a, b) => reasoningIndex(a) - reasoningIndex(b));
}

export function serverToolAssistantMessage(input: {
  calls: readonly ServerToolTranscriptCall[];
  stepContent: string | undefined;
  reasoningDetails?: readonly Reasoning[];
  responsesReasoning?: ResponsesReasoningState;
}): {
  assistant: Record<string, unknown>;
  toolCalls: ServerToolTranscriptToolCall[];
} {
  const toolCalls = input.calls.map((call) => ({
    id: call.id ?? `call_${randomId()}`,
    type: "function" as const,
    function: { name: call.name ?? "web_search", arguments: call.arguments ?? "" }
  }));
  const assistant: Record<string, unknown> = {
    role: "assistant",
    content:
      typeof input.stepContent === "string" && input.stepContent.length > 0
        ? input.stepContent
        : null,
    tool_calls: toolCalls
  };
  const canonicalReasoning = canonicalServerToolReasoning(input.reasoningDetails);
  if (canonicalReasoning.length > 0) {
    assistant.reasoning_details = canonicalReasoning;
  }
  const googleIndexes = Object.fromEntries(
    input.calls.flatMap((call, index) => {
      const id = toolCalls[index]?.id;
      return id !== undefined && call.providerIndex !== undefined ? [[id, call.providerIndex]] : [];
    })
  );
  if (Object.keys(googleIndexes).length > 0) {
    attachGoogleToolCallIndexes(assistant, googleIndexes);
  }
  if (input.responsesReasoning !== undefined) {
    attachResponsesReasoningMetadata(assistant, input.responsesReasoning);
  }
  const nativeReasoning = nativeAnthropicServerToolReasoning(canonicalReasoning);
  if (nativeReasoning.length > 0) {
    const nativeContent: AnthropicNativeContentBlock[] = nativeReasoning.map(
      (detail): AnthropicNativeContentBlock => {
        const metadata = anthropicReasoningExtension(detail);
        return metadata?.redacted === true
          ? { type: "redacted_thinking", data: detail.encryptedContent ?? "" }
          : {
              type: "thinking",
              thinking: detail.text ?? "",
              signature: metadata?.signature ?? ""
            };
      }
    );
    if (typeof input.stepContent === "string" && input.stepContent.length > 0) {
      nativeContent.push({ type: "text", text: input.stepContent });
    }
    for (const call of toolCalls) {
      let toolInput: unknown = {};
      try {
        toolInput = JSON.parse(call.function.arguments);
      } catch {
        toolInput = { raw: call.function.arguments };
      }
      nativeContent.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: toolInput
      });
    }
    Object.defineProperty(assistant, ANTHROPIC_MESSAGE_CONTENT, {
      value: nativeContent,
      enumerable: true
    });
  }
  return { assistant, toolCalls };
}
