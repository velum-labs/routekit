import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalize,
  codexCompatibility,
  cursorModelName,
  hashCanonical,
  isCodexPickerEligibleModel,
  parseRetryAfterSeconds,
  requestHash,
  responseHash,
  selectCodexStartupModel,
  stripCursorNamespace
} from "../index.js";
import type {
  CapabilityStatus,
  HarnessEvent,
  ModelCallContract,
  ModelEndpoint,
  ProviderError
} from "../index.js";

test("canonical hashing is stable across object insertion order", () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashCanonical({ b: 2, a: 1 }), hashCanonical({ a: 1, b: 2 }));
  assert.equal(requestHash({ b: 2, a: 1 }), responseHash({ a: 1, b: 2 }));
});

test("Cursor BYOK model names namespace under routekit/ and strip cleanly", () => {
  assert.equal(cursorModelName("claude-code/claude-fable-5"), "routekit/claude-code/claude-fable-5");
  assert.equal(cursorModelName("fusion-panel"), "routekit/fusion-panel");
  assert.equal(
    stripCursorNamespace("routekit/claude-code/claude-fable-5"),
    "claude-code/claude-fable-5"
  );
  assert.equal(stripCursorNamespace("claude-code/claude-fable-5"), undefined);
  assert.equal(stripCursorNamespace("routekit/"), undefined);
  assert.equal(cursorModelName("claude-code/claude-fable-5").startsWith("claude-"), false);
});

test("Retry-After parsing supports delay seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterSeconds("2"), 2);
  assert.equal(
    parseRetryAfterSeconds("Wed, 15 Jul 2026 14:30:05 GMT", () =>
      Date.parse("Wed, 15 Jul 2026 14:30:00 GMT")
    ),
    5
  );
  assert.equal(parseRetryAfterSeconds("-1"), undefined);
  assert.equal(parseRetryAfterSeconds("invalid"), undefined);
});

test("neutral model and harness contracts compose without product types", () => {
  const capability: CapabilityStatus = "supported";
  const endpoint: ModelEndpoint = {
    endpointId: "primary",
    model: "model-a",
    capabilities: { tools: capability }
  };
  const error: ProviderError = { kind: "rate_limited", retryable: true };
  const call: ModelCallContract = {
    call_id: "call-1",
    endpoint_id: endpoint.endpointId,
    model: endpoint.model,
    request_hash: requestHash({ prompt: "hello" }),
    messages: [{ role: "user", content: "hello" }],
    status: "failed",
    side_effects: "none",
    started_at: "2026-07-15T00:00:00.000Z",
    error
  };
  const event: HarnessEvent<"generic"> = {
    kind: "generic",
    sessionId: "session-1",
    at: "2026-07-15T00:00:00.000Z",
    type: "turn.failed",
    errorCode: error.kind,
    message: "retry"
  };

  assert.equal(call.endpoint_id, endpoint.endpointId);
  assert.equal(event.errorCode, "rate_limited");
});

test("Codex picker eligibility is conservative only for OpenRouter", () => {
  assert.equal(isCodexPickerEligibleModel({ provider: "openrouter" }), false);
  assert.equal(
    isCodexPickerEligibleModel({
      provider: "openrouter",
      reasoning: { status: "unknown" }
    }),
    false
  );
  assert.equal(
    isCodexPickerEligibleModel({
      provider: "openrouter",
      reasoning: { status: "supported" }
    }),
    true
  );
  assert.equal(isCodexPickerEligibleModel({ provider: "openai" }), true);
  assert.equal(isCodexPickerEligibleModel({}), true);
});

const textTools = {
  architecture: {
    inputModalities: ["text"],
    outputModalities: ["text"]
  },
  supportedParameters: ["tools", "tool_choice"]
} as const;

test("Codex compatibility requires advertised text output and tools", () => {
  assert.deepEqual(
    codexCompatibility({
      id: "openai/gpt-generation",
      provider: "openai",
      ...textTools
    }),
    { status: "compatible" }
  );
  assert.equal(
    codexCompatibility({
      id: "openai/text-embedding-ada-002",
      provider: "openai",
      architecture: {
        inputModalities: ["text"],
        outputModalities: ["embeddings"]
      }
    }).status,
    "incompatible"
  );
  assert.equal(
    codexCompatibility({
      id: "openai/undiscovered",
      provider: "openai"
    }).status,
    "unknown"
  );
  assert.equal(
    codexCompatibility({
      id: "openrouter/no-tools",
      provider: "openrouter",
      architecture: {
        inputModalities: ["text"],
        outputModalities: ["text"]
      },
      supportedParameters: [],
      reasoning: { status: "supported" }
    }).status,
    "incompatible"
  );
});

test("Codex implicit selection is deterministic and preserves billing scope", () => {
  const models = [
    {
      id: "openai/text-embedding-ada-002",
      provider: "openai",
      billingScope: "metered-api",
      architecture: {
        inputModalities: ["text"],
        outputModalities: ["embeddings"]
      }
    },
    {
      id: "openai/z-generation",
      provider: "openai",
      billingScope: "metered-api",
      ...textTools
    },
    {
      id: "openai/a-generation",
      provider: "openai",
      billingScope: "metered-api",
      ...textTools
    },
    {
      id: "codex/a-subscription",
      provider: "codex",
      billingScope: "subscription",
      ...textTools
    }
  ] as const;
  assert.equal(
    selectCodexStartupModel({
      models,
      preferredModel: "openai/text-embedding-ada-002"
    }).model,
    "openai/a-generation"
  );
  assert.throws(
    () =>
      selectCodexStartupModel({
        models: [models[0], models[3]],
        preferredModel: "openai/text-embedding-ada-002"
      }),
    /no advertised model/
  );
  assert.throws(
    () =>
      selectCodexStartupModel({
        models: [
          {
            id: "codex/embedding-only",
            provider: "codex",
            billingScope: "subscription",
            architecture: {
              inputModalities: ["text"],
              outputModalities: ["embeddings"]
            }
          },
          models[2]
        ],
        preferredModel: "codex/embedding-only"
      }),
    /no advertised model/
  );
});

test("Codex explicit selection remains exact even when capability metadata is unknown", () => {
  assert.equal(
    selectCodexStartupModel({
      models: [{ id: "openai/private-preview", provider: "openai" }],
      requestedModel: "openai/private-preview"
    }).model,
    "openai/private-preview"
  );
});
