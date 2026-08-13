import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredProviderIds,
  parseRouterConfig,
  resolveLeaderboardConfig,
  splitNamespacedModel
} from "../index.js";

test("router config accepts canonical provider maps and applies policy defaults", () => {
  const config = parseRouterConfig({
    providers: {
      openai: {},
      bedrock: {},
      codex: { strategy: "round_robin", switchThreshold: 0.8 }
    },
    defaultModel: "codex/gpt-5.5",
    leaderboard: {
      liveLimit: 5_000,
      liveTtlHours: 72,
      durable: true,
      durableRetentionDays: 14
    }
  });

  assert.equal(config.providers.openai?.strategy, "capacity_weighted");
  assert.equal(config.providers.bedrock?.strategy, "capacity_weighted");
  assert.equal(config.providers.codex?.strategy, "round_robin");
  assert.deepEqual(config.leaderboard, {
    liveLimit: 5_000,
    liveTtlHours: 72,
    durable: true,
    durableRetentionDays: 14
  });
  assert.deepEqual(resolveLeaderboardConfig({}), {
    liveLimit: 1_000,
    liveTtlHours: 24,
    durable: false,
    durableRetentionDays: 14
  });
});

test("router config rejects invalid model ownership and policy rules", () => {
  assert.throws(
    () => parseRouterConfig({ providers: { openai: {} }, defaultModel: "gpt-5.5" }),
    /provider\/model namespace/
  );
  assert.throws(
    () => parseRouterConfig({ providers: { openai: {} }, defaultModel: "codex/gpt-5.5" }),
    /provider "codex" is not configured/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelPolicy: { deny: ["openai/private", "openai/private"] }
      }),
    /duplicate model policy deny rule/
  );
  assert.throws(() => parseRouterConfig({ endpoints: [] }), /invalid input|unrecognized key/i);
});

test("router config rejects aliases that collide with canonical names or unavailable providers", () => {
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelAliases: { "openai/short": "openai/gpt-5.5" }
      }),
    /must not contain/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelAliases: { short: "codex/gpt-5.5" }
      }),
    /provider "codex" is not configured/
  );
  assert.deepEqual(splitNamespacedModel("claude-code/claude-sonnet"), {
    provider: "claude-code",
    model: "claude-sonnet"
  });
});

test("configured provider ids are the enabled schema keys", () => {
  const config = parseRouterConfig({
    providers: { codex: {}, openai: {} },
    defaultModel: "codex/gpt-5.5"
  });
  assert.deepEqual(configuredProviderIds(config), ["openai", "codex"]);
  assert.deepEqual(configuredProviderIds(parseRouterConfig({ providers: { openai: {} } })), [
    "openai"
  ]);
});
