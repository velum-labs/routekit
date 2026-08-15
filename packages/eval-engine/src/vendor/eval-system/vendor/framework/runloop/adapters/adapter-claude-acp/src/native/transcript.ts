import { Effect, Ref, Schema } from "effect";

import type { ClaudeInbound } from "./schema.ts";

type AssistantContent = Extract<
  ClaudeInbound,
  { readonly type: "assistant" }
>["message"]["content"][number];
type TextContent = Extract<AssistantContent, { readonly type: "text" }>;

const isTextBlock = (block: AssistantContent): block is TextContent =>
  block.type === "text";

const TRANSCRIPT_CAPACITY = 256;

// Role is derived from a `Schema.Literals` set, not a raw `"assistant" | "user"`
// union, so it shares one source of truth with the Pi replay decoder.
const ClaudeMessageRole = Schema.Literals(["user", "assistant"]);
type ClaudeTranscriptRole = typeof ClaudeMessageRole.Type;

interface ClaudeTranscriptMessage {
  readonly content: string;
  readonly role: ClaudeTranscriptRole;
}

type TranscriptRef = Ref.Ref<
  ReadonlyMap<string, readonly ClaudeTranscriptMessage[]>
>;

// ROUTEKIT_EVAL-owned per-session transcript replayed by session/load, bounded.
const recordMessage = (
  transcripts: TranscriptRef,
  sessionId: string,
  message: ClaudeTranscriptMessage
): Effect.Effect<void> =>
  Ref.update(transcripts, (current) => {
    const history = current.get(sessionId) ?? [];
    return new Map(current).set(
      sessionId,
      [...history, message].slice(-TRANSCRIPT_CAPACITY)
    );
  });

const recordAgentText = (
  transcripts: TranscriptRef,
  sessionId: string,
  value: ClaudeInbound
): Effect.Effect<void> => {
  if (value.type !== "assistant") {
    return Effect.void;
  }
  const text = value.message.content
    .flatMap((block) => (isTextBlock(block) ? [block.text] : []))
    .join("");
  return text.length === 0
    ? Effect.void
    : recordMessage(transcripts, sessionId, {
        content: text,
        role: "assistant",
      });
};

export { recordAgentText, recordMessage };
export type { ClaudeTranscriptMessage, TranscriptRef };
