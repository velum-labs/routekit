import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";
import type { ToolIntegration } from "@velum-labs/routekit-tools";
import { buildToolLaunchSpec, launchToolWithIntegration, routekitToolRegistry } from "../launch.js";

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
