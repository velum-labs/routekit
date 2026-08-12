import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeModelDiscovery,
  decodeReasoningCapabilities,
  ModelDiscoveryProtocolError
} from "../provider-discovery.js";

test("model discovery rejects malformed boundaries with a named protocol error", () => {
  assert.throws(
    () => decodeModelDiscovery("openai", { data: {} }, { provider: "openai" }),
    (error: unknown) =>
      error instanceof ModelDiscoveryProtocolError &&
      error.code === "missing_model_array" &&
      error.provider === "openai" &&
      error.payloadSnippet === "{}"
  );
  assert.throws(
    () => decodeModelDiscovery("anthropic", null, { provider: "claude-code" }),
    (error: unknown) =>
      error instanceof ModelDiscoveryProtocolError &&
      error.code === "invalid_payload" &&
      error.provider === "claude-code"
  );
});

test("model discovery reports skipped entries and returns canonical models", () => {
  const diagnostics: string[] = [];
  const models = decodeModelDiscovery(
    "codex",
    {
      models: [
        { slug: "" },
        { slug: "gpt-example", priority: 3 },
        { slug: "gpt-example" },
        { slug: "hidden", supported_in_api: false }
      ]
    },
    {
      provider: "codex",
      refreshedAt: "2026-08-12T00:00:00.000Z",
      onDiagnostic: ({ code }) => diagnostics.push(code)
    }
  );

  assert.deepEqual(models, [
    {
      id: "gpt-example",
      providerPriority: 3,
      metadata: {
        architecture: {
          modality: "text->text",
          inputModalities: ["text"],
          outputModalities: ["text"]
        },
        supportedParameters: ["tools", "tool_choice"],
        provenance: "route"
      }
    }
  ]);
  assert.deepEqual(diagnostics, [
    "invalid_model",
    "duplicate_model",
    "provider_hidden_model"
  ]);
});

test("reasoning discovery normalizes provider-specific capability metadata", () => {
  assert.deepEqual(
    decodeReasoningCapabilities(
      {
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            high: { supported: true }
          },
          thinking: {
            supported: true,
            types: {
              adaptive: { supported: true },
              enabled: { supported: true }
            }
          }
        }
      },
      {
        provider: "claude-code",
        refreshedAt: "2026-08-12T00:00:00.000Z"
      }
    ),
    {
      status: "supported",
      efforts: [{ id: "low" }, { id: "high" }],
      budget: { minTokens: 1_024 },
      adaptive: true,
      wireShape: "anthropic",
      provenance: "provider",
      refreshedAt: "2026-08-12T00:00:00.000Z"
    }
  );
});
