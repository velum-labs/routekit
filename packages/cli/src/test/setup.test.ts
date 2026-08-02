import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderSource } from "@velum-labs/routekit-gateway";

import { activationKey } from "../commands/accounts.js";
import {
  CONFIG_INIT_PROVIDER_IDS,
  configInitIdempotencyKey,
  configInitRouterConfig
} from "../commands/config.js";
import {
  SETUP_API_PROVIDER_IDS,
  credentialDescription,
  preferredModelOptions,
  preflightSetupApiProvider,
  setupCandidateConfig
} from "../commands/setup.js";

function source(
  sourceId: "openai" | "anthropic" | "openrouter" | "bedrock",
  models: string[],
  closed: { value: boolean }
): ProviderSource {
  return {
    sourceId,
    discoverModels: async () => models.map((id) => ({ id })),
    chat: async () => new Response(),
    embeddings: async () => new Response(),
    close: () => {
      closed.value = true;
    }
  };
}

test("config init keeps the no-flag OpenAI starter and builds API starters", () => {
  assert.deepEqual(CONFIG_INIT_PROVIDER_IDS, ["openai", "anthropic", "openrouter", "bedrock"]);
  const openai = configInitRouterConfig();
  assert.deepEqual(Object.keys(openai.providers), ["openai"]);
  assert.equal(openai.defaultModel, "openai/gpt-5.5");
  const anthropic = configInitRouterConfig({ provider: "anthropic" });
  assert.deepEqual(Object.keys(anthropic.providers), ["anthropic"]);
  assert.equal(anthropic.defaultModel, "anthropic/claude-sonnet-4-5");
  const openrouter = configInitRouterConfig({ provider: "openrouter" });
  assert.deepEqual(Object.keys(openrouter.providers), ["openrouter"]);
  assert.equal(openrouter.defaultModel, "openrouter/anthropic/claude-sonnet-4.5");
  const bedrock = configInitRouterConfig({
    provider: "bedrock",
    defaultModel: "bedrock/us.anthropic.claude-sonnet"
  });
  assert.deepEqual(Object.keys(bedrock.providers), ["bedrock"]);
  assert.equal(bedrock.defaultModel, "bedrock/us.anthropic.claude-sonnet");
  assert.deepEqual(configInitRouterConfig({ empty: true }), { providers: {} });
});

test("config init validates explicit defaults and hashes the generated config", () => {
  assert.throws(
    () => configInitRouterConfig({ provider: "bedrock" }),
    /requires.*--default-model/i
  );
  assert.throws(
    () =>
      configInitRouterConfig({
        provider: "anthropic",
        defaultModel: "openai/gpt-5.5"
      }),
    /does not belong/
  );
  assert.throws(
    () => configInitRouterConfig({ defaultModel: "openai/gpt-5.5" }),
    /requires --provider/
  );
  const openai = configInitIdempotencyKey({
    revision: 3,
    config: configInitRouterConfig({ provider: "openai" })
  });
  const anthropic = configInitIdempotencyKey({
    revision: 3,
    config: configInitRouterConfig({ provider: "anthropic" })
  });
  assert.notEqual(openai, anthropic);
  assert.match(openai, /^config-init-3-[a-f0-9]{24}$/);
});

test("subscription activation idempotency never depends on credential values", () => {
  const first = activationKey("codex", [
    { label: "work", credential: { accessToken: "first-secret" } }
  ]);
  const second = activationKey("codex", [
    { label: "work", credential: { accessToken: "second-secret" } }
  ]);
  assert.equal(first, second);
  assert.doesNotMatch(first, /secret/);
});

test("setup creates a provider-only candidate without choosing a temporary default", () => {
  assert.deepEqual(SETUP_API_PROVIDER_IDS, ["openai", "anthropic", "openrouter", "bedrock"]);
  assert.deepEqual(Object.keys(setupCandidateConfig(["openai", "anthropic"]).providers), [
    "openai",
    "anthropic"
  ]);
  assert.equal(credentialDescription("openai"), "OPENAI_API_KEY");
  assert.match(credentialDescription("bedrock"), /AWS SDK/);
});

test("setup API preflight discovers live models and closes the temporary source", async () => {
  const closed = { value: false };
  const result = await preflightSetupApiProvider("openai", {
    env: { OPENAI_API_KEY: "test" },
    source: source("openai", ["gpt-test", "gpt-second"], closed)
  });
  assert.deepEqual(result, {
    provider: "openai",
    models: ["openai/gpt-test", "openai/gpt-second"]
  });
  assert.equal(closed.value, true);
});

test("setup API preflight rejects missing credentials before discovery", async () => {
  const closed = { value: false };
  await assert.rejects(
    preflightSetupApiProvider("openrouter", {
      env: {},
      source: source("openrouter", ["model"], closed)
    }),
    /set OPENROUTER_API_KEY/
  );
  assert.equal(closed.value, false);
});

test("setup API preflight redacts credential values from discovery errors", async () => {
  const closed = { value: false };
  const failing = source("openai", ["unused"], closed);
  failing.discoverModels = async () => {
    throw new Error("upstream rejected test-secret");
  };
  await assert.rejects(
    preflightSetupApiProvider("openai", {
      env: { OPENAI_API_KEY: "test-secret" },
      source: failing
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /test-secret/);
      assert.match(message, /\[redacted\]/);
      return true;
    }
  );
  assert.equal(closed.value, true);
});

test("live model options preserve a valid default then prefer the selected route default", () => {
  const models = [
    { id: "anthropic/claude-opus-4-8" },
    { id: "openai/gpt-5.5" },
    { id: "anthropic/claude-sonnet-4-5" }
  ];
  assert.equal(
    preferredModelOptions(models, {
      currentDefault: "anthropic/claude-opus-4-8",
      firstSelectedRoute: "openai"
    })[0]?.value,
    "anthropic/claude-opus-4-8"
  );
  assert.equal(
    preferredModelOptions(models, {
      firstSelectedRoute: "openai"
    })[0]?.value,
    "openai/gpt-5.5"
  );
});
