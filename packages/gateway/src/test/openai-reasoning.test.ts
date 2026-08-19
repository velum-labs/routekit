import assert from "node:assert/strict";
import { test } from "node:test";

import {
  openaiChatUsesMaxCompletionTokens,
  openaiReasoningCapabilities
} from "../providers/openai-reasoning.js";

test("OpenAI source authors verified GPT-5.5 and GPT-5.6 reasoning controls", () => {
  assert.deepEqual(openaiReasoningCapabilities("gpt-5.6-sol"), {
    status: "supported",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
    defaultEffort: "medium",
    wireShape: "openai-responses",
    provenance: "builtin"
  });
  assert.deepEqual(openaiReasoningCapabilities("gpt-5.6-2026-01-01"), {
    status: "supported",
    efforts: ["none", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
    defaultEffort: "medium",
    wireShape: "openai-responses",
    provenance: "builtin"
  });
  assert.deepEqual(openaiReasoningCapabilities("gpt-5.5"), {
    status: "supported",
    efforts: ["none", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
    wireShape: "openai-chat",
    provenance: "builtin"
  });
  assert.equal(openaiReasoningCapabilities("gpt-4o"), undefined);
  assert.equal(openaiReasoningCapabilities("gpt-5.4"), undefined);
});

test("GPT-5 Chat Completions family uses max_completion_tokens", () => {
  for (const model of [
    "gpt-5",
    "gpt-5.5",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5-mini",
    "openai/gpt-5.5",
    "openai.gpt-5.6-sol",
    "bedrock/openai.gpt-5.6-sol",
    "routekit/bedrock/us.openai.gpt-5.6-sol"
  ]) {
    assert.equal(openaiChatUsesMaxCompletionTokens(model), true, model);
  }
  for (const model of ["gpt-4o", "gpt-4.1", "o3", "claude-sonnet-4-6", "not-gpt-5.6"]) {
    assert.equal(openaiChatUsesMaxCompletionTokens(model), false, model);
  }
});
