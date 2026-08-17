import assert from "node:assert/strict";
import test from "node:test";

import { deriveRoutingRequirements } from "../routing-requirements.js";

test("derives hard routing requirements from each supported request envelope", () => {
  assert.deepEqual(
    deriveRoutingRequirements("chat", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
          ]
        }
      ],
      tools: [{ type: "function", function: { name: "read" } }],
      max_completion_tokens: 2048
    }),
    {
      endpoint: "chat",
      requiresTools: true,
      requiresVision: true,
      maxOutputTokens: 2048
    }
  );

  assert.deepEqual(
    deriveRoutingRequirements("responses", {
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://invalid" }] }],
      max_output_tokens: 4096
    }),
    {
      endpoint: "responses",
      requiresTools: false,
      requiresVision: true,
      maxOutputTokens: 4096
    }
  );

  assert.deepEqual(
    deriveRoutingRequirements("anthropic", {
      messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      max_tokens: 1024
    }),
    {
      endpoint: "anthropic",
      requiresTools: false,
      requiresVision: true,
      maxOutputTokens: 1024
    }
  );
});

test("does not infer capabilities from arbitrary nested text or invalid limits", () => {
  assert.deepEqual(
    deriveRoutingRequirements("chat", {
      metadata: { type: "image" },
      messages: [{ role: "user", content: "please create an image" }],
      tools: [],
      max_completion_tokens: -1
    }),
    {
      endpoint: "chat",
      requiresTools: false,
      requiresVision: false
    }
  );
});
