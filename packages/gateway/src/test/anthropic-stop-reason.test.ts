import assert from "node:assert/strict";
import { test } from "node:test";

import { mapStopReason } from "../adapters/anthropic-codec.js";
import { openAiFinishReasonFromAnthropic } from "../providers/anthropic-codec.js";

/**
 * Core pairs that must round-trip. Inbound Claude Code (`mapStopReason`) and
 * outbound Anthropic Messages (`openAiFinishReasonFromAnthropic`) stay in
 * separate codecs; this table is the lock that they remain inverses.
 */
const INVERSE_PAIRS = [
  ["stop", "end_turn"],
  ["length", "max_tokens"],
  ["tool_calls", "tool_use"],
  ["content_filter", "refusal"]
] as const;

test("Anthropic inbound and outbound stop-reason maps stay inverses", () => {
  for (const [openai, anthropic] of INVERSE_PAIRS) {
    assert.equal(mapStopReason(openai), anthropic);
    assert.equal(openAiFinishReasonFromAnthropic(anthropic), openai);
    assert.equal(openAiFinishReasonFromAnthropic(mapStopReason(openai)), openai);
    assert.equal(mapStopReason(openAiFinishReasonFromAnthropic(anthropic)), anthropic);
  }

  // Outbound-only: Anthropic reports a distinct context-window stop with no
  // inbound OpenAI finish_reason, so the round-trip collapses to max_tokens.
  assert.equal(openAiFinishReasonFromAnthropic("model_context_window_exceeded"), "length");
  assert.equal(mapStopReason("length"), "max_tokens");
});
