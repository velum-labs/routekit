import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentProfile, ToolLaunchSpec } from "@velum-labs/routekit-tools";

import {
  codexAgentRoleToml,
  codexCatalogEntries,
  codexLaunchConfigToml,
  codexModelCatalogJson,
  codexPersistentModelCatalogJson,
  createIsolatedCodexHome,
  resolveCodexHome
} from "../launch.js";

const SPEC: ToolLaunchSpec = {
  gatewayUrl: "http://127.0.0.1:9999",
  defaultModel: "opaque-primary",
  models: [
    {
      id: "opaque-primary",
      label: "Primary",
      aliases: ["primary-alias"],
      reasoning: {
        status: "supported",
        efforts: [{ id: "quick" }, { id: "deep" }],
        defaultEffort: "quick",
        provenance: "provider"
      }
    },
    {
      id: "opaque-secondary",
      reasoning: { status: "unknown", provenance: "unknown" }
    }
  ],
  args: []
};

const PROFILE: AgentProfile = {
  id: "reviewer",
  model: "opaque-secondary",
  description: "Review changes.",
  instructions: "Return concise findings."
};

test("Codex launcher serializes namespaced models without interpreting provider ids", () => {
  const template = {
    slug: "stock",
    display_name: "Stock",
    visibility: "list",
    supported_reasoning_levels: [{ effort: "template" }],
    default_reasoning_level: "template"
  };
  const entries = codexCatalogEntries(SPEC, template, [
    template,
    { slug: "opaque-secondary", display_name: "duplicate" }
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["opaque-primary", "primary-alias", "opaque-secondary", "stock"]
  );
  assert.equal(entries[0]?.display_name, "Primary");
  assert.deepEqual(entries[0]?.supported_reasoning_levels, [
    { effort: "quick", description: "quick" },
    { effort: "deep", description: "deep" }
  ]);
  assert.deepEqual(entries[2]?.supported_reasoning_levels, []);
  assert.deepEqual(JSON.parse(codexModelCatalogJson(SPEC, template)).models, entries.slice(0, 3));
});

test("Codex launcher filters incompatible OpenRouter models and aliases", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "openai/unknown",
    models: [
      { id: "openrouter/chat-only", provider: "openrouter", aliases: ["chat-alias"] },
      {
        id: "openrouter/reasoning",
        provider: "openrouter",
        aliases: ["reasoning-alias"],
        reasoning: { status: "supported", provenance: "provider" }
      },
      { id: "openai/unknown", provider: "openai", aliases: ["openai-alias"] }
    ],
    args: []
  };
  assert.deepEqual(
    codexCatalogEntries(spec, { slug: "stock" }, [], { appendUnlistedStock: false }).map(
      (entry) => entry.slug
    ),
    ["openai/unknown", "openrouter/reasoning", "reasoning-alias", "openai-alias"]
  );
});

test("Codex launcher neutralizes stock-model behavior for gateway-routed models", () => {
  const template = {
    slug: "gpt-stock",
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    additional_speed_tiers: ["fast"],
    service_tiers: [{ id: "priority" }],
    default_service_tier: "priority",
    base_instructions: "You are Codex, an agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, an agent based on GPT-5." }
  };
  const [entry] = codexCatalogEntries(SPEC, template);
  assert.ok(entry);
  assert.equal("tool_mode" in entry, false);
  assert.equal(entry.use_responses_lite, false);
  assert.deepEqual(entry.additional_speed_tiers, []);
  assert.deepEqual(entry.service_tiers, []);
  assert.equal(entry.base_instructions, "You are a coding agent.");
  assert.deepEqual(entry.model_messages, { instructions_template: "You are a coding agent." });
});

test("Codex keeps real stock ModelInfo only for Codex-native models", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "codex/gpt-5.5",
    models: [{ id: "codex/gpt-5.5" }, { id: "claude-code/gpt-5.4" }],
    args: []
  };
  const stock = [{ slug: "gpt-5.5", tool_mode: "code_mode_only" }, { slug: "gpt-5.4" }];
  const [native, foreign] = codexCatalogEntries(spec, { slug: "stock" }, stock, {
    appendUnlistedStock: false
  });
  assert.equal(native?.tool_mode, "code_mode_only");
  assert.equal(foreign?.tool_mode, undefined);
});

test("Codex launcher serializes a gateway provider and generic agent profiles", () => {
  const role = { ...PROFILE, configPath: "/tmp/reviewer.toml" };
  const config = codexLaunchConfigToml({ ...SPEC, auth: { token: "test" } }, "/tmp/catalog.json", [
    role
  ]);
  assert.match(config, /model = "opaque-primary"/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
  assert.match(config, /env_key = "ROUTEKIT_GATEWAY_TOKEN"/);
  assert.match(config, /config_file = "\/tmp\/reviewer\.toml"/);
  assert.match(codexAgentRoleToml(PROFILE), /developer_instructions = "Return concise findings\."/);
});

test("persistent Codex profiles carry matching model metadata", () => {
  const catalog = JSON.parse(
    codexPersistentModelCatalogJson([
      {
        id: "openai/gpt-4o-mini",
        reasoning: {
          status: "supported",
          efforts: [{ id: "low" }, { id: "high" }],
          defaultEffort: "low",
          provenance: "provider"
        }
      },
      { id: "codex/gpt-5.6" }
    ])
  ) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(catalog.models.map((model) => model.slug), [
    "openai/gpt-4o-mini",
    "codex/gpt-5.6"
  ]);
  assert.deepEqual(catalog.models[0]?.supported_reasoning_levels, [
    { effort: "low", description: "low" },
    { effort: "high", description: "high" }
  ]);
  assert.equal(catalog.models[0]?.supports_reasoning_summaries, true);
});

test("Codex normal home honors absolute CODEX_HOME and rejects relative values", () => {
  assert.equal(resolveCodexHome({ CODEX_HOME: "/private/codex" }), "/private/codex");
  assert.throws(() => resolveCodexHome({ CODEX_HOME: "relative" }), /absolute path/);
});

test("isolated Codex homes used by the harness live under the user cache", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-home-test-"));
  const userHome = join(root, "home");
  try {
    const isolated = createIsolatedCodexHome("driver-", { HOME: userHome });
    assert.ok(isolated.startsWith(join(userHome, ".cache", "routekit", "codex", "driver-")));
    assert.equal(existsSync(isolated), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
