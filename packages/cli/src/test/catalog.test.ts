import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchLiveCatalog } from "../catalog.js";

const models = [
  {
    id: "openai/text-embedding-ada-002",
    created: 100,
    routekit_provider_priority: 2,
    capabilities: {},
    architecture: {
      modality: "text->embeddings",
      input_modalities: ["text"],
      output_modalities: ["embeddings"]
    },
    supported_parameters: []
  },
  { id: "openai/gpt-5.6-sol", capabilities: { streaming: "supported" } },
  {
    id: "claude-code/claude-fable-5",
    capabilities: { streaming: "supported" },
    reasoning: {
      status: "supported",
      efforts: [{ id: "low" }, { id: "high" }],
      budget: { minTokens: 1_024 },
      adaptive: true,
      wireShape: "anthropic",
      provenance: "provider"
    }
  }
];

test("external catalog uses the gateway's advertised default model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      default_model: "openai/gpt-5.6-sol",
      data: models
    });
  try {
    const catalog = await fetchLiveCatalog("https://gateway.test");
    assert.equal(catalog.defaultModel, "openai/gpt-5.6-sol");
    assert.deepEqual(catalog.models[0]?.architecture, {
      modality: "text->embeddings",
      inputModalities: ["text"],
      outputModalities: ["embeddings"]
    });
    assert.equal(catalog.models[0]?.createdAt, 100);
    assert.equal(catalog.models[0]?.providerPriority, 2);
    assert.deepEqual(
      catalog.models.find(
        (model) => model.id === "claude-code/claude-fable-5"
      )?.reasoning?.efforts,
      [{ id: "low" }, { id: "high" }]
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("the gateway default overrides a local fallback model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      default_model: "openai/gpt-5.6-sol",
      data: models
    });
  try {
    const catalog = await fetchLiveCatalog("https://gateway.test", {
      defaultModel: "openai/text-embedding-ada-002"
    });
    assert.equal(catalog.defaultModel, "openai/gpt-5.6-sol");
  } finally {
    globalThis.fetch = original;
  }
});
