import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDiscoveredModels } from "../provider-source.js";

test("Anthropic discovery projects authoritative effort and thinking capabilities", () => {
  const [model] = parseDiscoveredModels(
    "anthropic",
    {
      data: [
        {
          id: "claude-fable-5",
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: false },
              high: { supported: true },
              xhigh: null,
              max: { supported: true }
            },
            thinking: {
              supported: true,
              types: {
                adaptive: { supported: true },
                enabled: { supported: true }
              }
            }
          }
        }
      ]
    },
    "claude-code"
  );

  assert.deepEqual(model?.reasoning, {
    status: "supported",
    efforts: [{ id: "low" }, { id: "high" }, { id: "max" }],
    budget: { minTokens: 1_024 },
    adaptive: true,
    wireShape: "anthropic",
    provenance: "provider",
    refreshedAt: model?.reasoning?.refreshedAt
  });
  assert.equal(model?.reasoning?.defaultEffort, undefined);
});

test("Anthropic discovery preserves explicit unsupported and missing capabilities", () => {
  const models = parseDiscoveredModels(
    "anthropic",
    {
      data: [
        {
          id: "claude-no-reasoning",
          capabilities: {
            effort: { supported: false },
            thinking: {
              supported: false,
              types: {
                adaptive: { supported: false },
                enabled: { supported: false }
              }
            }
          }
        },
        { id: "claude-unknown" }
      ]
    },
    "claude-code"
  );

  assert.deepEqual(models[0]?.reasoning, {
    status: "unsupported",
    adaptive: false,
    wireShape: "anthropic",
    provenance: "provider",
    refreshedAt: models[0]?.reasoning?.refreshedAt
  });
  assert.equal(models[1]?.reasoning, undefined);
});

test("OpenRouter discovery preserves its architecture and supported parameters", () => {
  const [model] = parseDiscoveredModels(
    "openai",
    {
      data: [
        {
          id: "openai/example",
          created: 1_782_228_658,
          architecture: {
            modality: "text->text",
            input_modalities: ["text"],
            output_modalities: ["text"]
          },
          supported_parameters: ["tools", "tool_choice"]
        }
      ]
    },
    "openrouter"
  );
  assert.deepEqual(model?.metadata, {
    architecture: {
      modality: "text->text",
      inputModalities: ["text"],
      outputModalities: ["text"]
    },
    supportedParameters: ["tools", "tool_choice"],
    provenance: "provider"
  });
  assert.equal(model?.createdAt, 1_782_228_658);
});

test("subscription discovery projects effective Codex route capabilities", () => {
  const codex = parseDiscoveredModels(
    "codex",
    {
      models: [
        {
          slug: "gpt-generation",
          input_modalities: ["text", "image"],
          priority: 1
        },
        { slug: "hidden", supported_in_api: false }
      ]
    },
    "codex"
  );
  assert.deepEqual(codex.map((model) => model.id), ["gpt-generation"]);
  assert.equal(codex[0]?.providerPriority, 1);
  assert.deepEqual(codex[0]?.metadata, {
    architecture: {
      modality: "text+image->text",
      inputModalities: ["text", "image"],
      outputModalities: ["text"]
    },
    supportedParameters: ["tools", "tool_choice"],
    provenance: "route"
  });

  const [claude] = parseDiscoveredModels(
    "anthropic",
    {
      data: [
        {
          id: "claude-vision",
          created_at: "2026-07-09T12:34:56.789Z",
          capabilities: { image_input: { supported: true } }
        }
      ]
    },
    "claude-code"
  );
  assert.deepEqual(claude?.metadata?.architecture?.inputModalities, ["text", "image"]);
  assert.deepEqual(claude?.metadata?.architecture?.outputModalities, ["text"]);
  assert.deepEqual(claude?.metadata?.supportedParameters, ["tools", "tool_choice"]);
  assert.equal(claude?.createdAt, 1_783_600_496);
});

test("direct OpenAI discovery remains capability-unknown before live enrichment", () => {
  const [model] = parseDiscoveredModels(
    "openai",
    { data: [{ id: "gpt-private-preview", created: 1_782_228_658 }] },
    "openai"
  );
  assert.equal(model?.metadata, undefined);
  assert.equal(model?.createdAt, 1_782_228_658);
});

test("discovery ignores malformed selection signals without inferring catalog priority", () => {
  const openai = parseDiscoveredModels(
    "openai",
    {
      data: [
        { id: "first", created: -1 },
        { id: "second", created: 1.5 }
      ]
    },
    "openai"
  );
  assert.deepEqual(
    openai.map(({ id, createdAt, providerPriority }) => ({
      id,
      createdAt,
      providerPriority
    })),
    [
      { id: "first", createdAt: undefined, providerPriority: undefined },
      { id: "second", createdAt: undefined, providerPriority: undefined }
    ]
  );

  const codex = parseDiscoveredModels(
    "codex",
    {
      models: [
        { slug: "first", priority: -1 },
        { slug: "second", priority: 1.5 }
      ]
    },
    "codex"
  );
  assert.equal(codex[0]?.providerPriority, undefined);
  assert.equal(codex[1]?.providerPriority, undefined);
});
