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
});

test("subscription discovery projects effective Codex route capabilities", () => {
  const codex = parseDiscoveredModels(
    "codex",
    {
      models: [
        { slug: "gpt-generation", input_modalities: ["text", "image"] },
        { slug: "hidden", supported_in_api: false }
      ]
    },
    "codex"
  );
  assert.deepEqual(codex.map((model) => model.id), ["gpt-generation"]);
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
          capabilities: { image_input: { supported: true } }
        }
      ]
    },
    "claude-code"
  );
  assert.deepEqual(claude?.metadata?.architecture?.inputModalities, ["text", "image"]);
  assert.deepEqual(claude?.metadata?.architecture?.outputModalities, ["text"]);
  assert.deepEqual(claude?.metadata?.supportedParameters, ["tools", "tool_choice"]);
});

test("direct OpenAI discovery remains capability-unknown before live enrichment", () => {
  const [model] = parseDiscoveredModels(
    "openai",
    { data: [{ id: "gpt-private-preview" }] },
    "openai"
  );
  assert.equal(model?.metadata, undefined);
});
