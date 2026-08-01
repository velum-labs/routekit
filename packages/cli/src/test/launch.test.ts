import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";
import type { ToolIntegration } from "@velum-labs/routekit-tools";
import {
  buildToolLaunchSpec,
  launchToolWithIntegration,
  resolveCodexLaunchSelection,
  routekitToolRegistry
} from "../launch.js";

const config = parseRouterConfig({
  providers: { openai: {}, codex: {} },
  defaultModel: "codex/gpt-5.5"
});
const catalog = [
  {
    id: "openai/gpt-5.5",
    provider: "openai",
    capabilities: {
      streaming: "supported",
      tools: "degraded",
      images: "unsupported",
      reasoning_controls: "unknown"
    }
  },
  {
    id: "codex/gpt-5.5",
    provider: "codex",
    capabilities: {},
    reasoning: {
      status: "supported",
      efforts: [{ id: "balanced", aliases: ["cursor-balanced"] }],
      defaultEffort: "balanced",
      provenance: "provider"
    }
  }
] as const;

test("every canonical launcher receives the same live catalog specification", () => {
  assert.ok(routekitToolRegistry.list().length > 0);
  for (const tool of routekitToolRegistry.list()) {
    const spec = buildToolLaunchSpec({
      config,
      catalog,
      gatewayUrl: "http://127.0.0.1:8000",
      args: ["--example"]
    });
    assert.equal(spec.defaultModel, "codex/gpt-5.5", tool.id);
    assert.deepEqual(
      spec.models.map((entry) => entry.id),
      ["openai/gpt-5.5", "codex/gpt-5.5"]
    );
    assert.deepEqual(spec.args, ["--example"]);
    assert.equal(spec.models[0]?.provider, "openai");
    assert.equal(spec.models[1]?.provider, "codex");
    assert.equal(spec.models[0]?.features?.streaming, "full");
    assert.equal(spec.models[0]?.features?.tools, "degraded");
    assert.equal(spec.models[0]?.features?.images, "unsupported");
  }
});

test("launch effort resolves against the selected model capability", () => {
  const spec = buildToolLaunchSpec({
    config,
    catalog,
    gatewayUrl: "https://gateway.example",
    effort: "cursor-balanced"
  });
  assert.deepEqual(spec.reasoning, {
    mode: "effort",
    effort: "balanced"
  });
  assert.throws(
    () =>
      buildToolLaunchSpec({
        config,
        catalog,
        gatewayUrl: "https://gateway.example",
        effort: "maximum"
      }),
    /not supported/
  );
});

test("an explicitly requested model absent from the live catalog is rejected", () => {
  assert.throws(
    () =>
      buildToolLaunchSpec({
        config,
        catalog,
        gatewayUrl: "https://gateway.example",
        model: "openrouter/caller-provided",
        authToken: "private"
      }),
    /unknown model "openrouter\/caller-provided"/
  );
});

test("tool launches return the native client's exit code", async () => {
  const integration = {
    ...routekitToolRegistry.get("claude")!,
    launch: async (context) => {
      assert.equal(context.spec.defaultModel, "codex/gpt-5.5");
      return 7;
    }
  } satisfies ToolIntegration;
  const result = await launchToolWithIntegration(
    integration,
    buildToolLaunchSpec({
      config,
      catalog,
      gatewayUrl: "http://127.0.0.1:8000"
    })
  );
  assert.equal(result, 7);
});

test("remote Codex startup replaces an embedding default deterministically", async () => {
  const models = [
    {
      id: "openai/text-embedding-ada-002",
      provider: "openai",
      capabilities: {},
      architecture: {
        inputModalities: ["text"],
        outputModalities: ["embeddings"]
      }
    },
    {
      id: "openai/z-generation",
      provider: "openai",
      createdAt: 200,
      capabilities: {},
      architecture: {
        inputModalities: ["text"],
        outputModalities: ["text"]
      },
      supportedParameters: ["tools"]
    },
    {
      id: "openai/a-generation",
      provider: "openai",
      createdAt: 100,
      capabilities: {},
      architecture: {
        inputModalities: ["text"],
        outputModalities: ["text"]
      },
      supportedParameters: ["tools"]
    }
  ] as const;
  const selected = await resolveCodexLaunchSelection({
    models,
    preferredModel: "openai/text-embedding-ada-002"
  });
  assert.equal(selected.model, "openai/z-generation");
  assert.equal(selected.modelSelection, "implicit");
  assert.equal(selected.models[1]?.createdAt, 200);
});

test("remote Codex startup preserves an exact explicit model without capability substitution", async () => {
  const selected = await resolveCodexLaunchSelection({
    models: [
      {
        id: "openai/private-preview",
        provider: "openai",
        capabilities: {}
      }
    ],
    preferredModel: "openai/private-preview",
    model: "openai/private-preview",
    modelSelection: "explicit"
  });
  assert.equal(selected.model, "openai/private-preview");
  assert.equal(selected.modelSelection, "explicit");
});
