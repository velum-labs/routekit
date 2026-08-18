import assert from "node:assert/strict";
import { test } from "node:test";

import { openaiReasoningCapabilities } from "../providers/openai-reasoning.js";

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
