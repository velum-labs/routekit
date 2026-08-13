import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";

import {
  AccountActivityCoordinator,
  type AccountLimits,
  type DiscoveryResult,
  deferred,
  fakeProvider,
  fromAsync,
  healthyUsage,
  openAccountSet,
  persistedCoolingUntil,
  quotaCool,
  RateLimitTracker,
  type ResetCreditSnapshot,
  reasoningModel,
  runExecute,
  SUBSCRIPTION_SSE_BUFFER_CAP_BYTES,
  SubscriptionAccountSetAuthError,
  type SubscriptionCredential,
  type SubscriptionProvider,
  SubscriptionProviderRequestError,
  SubscriptionRefreshError,
  sanitizeSubscriptionLabel,
  subscriptionProvider,
  waitFor,
  writeMember
} from "./subscription-pool-fixtures.js";

test("discovery re-mints a credential the provider stopped honoring", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-stale-"));
  // A far-future expiry claim: nothing about this token looks refreshable.
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  const state = { refreshes: 0 };
  const provider = fakeProvider(state);
  const attempts: string[] = [];
  provider.discoverModels = (credential) =>
    fromAsync(async () => {
      attempts.push(credential.accessToken);
      if (credential.accessToken === "token-a") {
        throw new SubscriptionProviderRequestError({
          category: "auth_permanent",
          scope: "credential",
          status: 401,
          message: "model discovery returned HTTP 401"
        });
      }
      return [{ id: "gpt-5.3-codex" }];
    });
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory }
  });
  try {
    assert.deepEqual(await pool.discoverModels(), ["gpt-5.3-codex"]);
    assert.deepEqual(attempts, ["token-a", "token-a-refreshed"]);
    assert.equal(state.refreshes, 1);
    assert.equal(pool.statusSnapshot().members[0]?.relayReady, true);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed discovery keeps the last known catalog instead of darkening the pool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-retain-"));
  // No refresh token, so the failure survives the one re-mint attempt.
  writeMember(directory, "a", { accessToken: "token-a" });
  const provider = fakeProvider({ refreshes: 0 });
  let discoveryFails = false;
  provider.discoverModels = () =>
    fromAsync(async () => {
      if (discoveryFails) throw new Error("model discovery returned HTTP 503");
      return reasoningModel("high");
    });
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory }
  });
  try {
    assert.deepEqual(await pool.discoverModels(), ["gpt-shared"]);
    discoveryFails = true;
    assert.deepEqual(await pool.discoverModels(), ["gpt-shared"]);
    assert.deepEqual(pool.reasoningCapabilities("gpt-shared")?.efforts, [{ id: "high" }]);
    assert.deepEqual(pool.modelSelectionSignals("gpt-shared"), {
      createdAt: 200,
      providerPriority: 1
    });
    assert.equal(pool.statusSnapshot().members[0]?.poolEligible, true);
    const response = await runExecute(pool, "gpt-shared", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await response.text(), "token-a");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a discovery in flight does not report members as unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-inflight-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const provider = fakeProvider({ refreshes: 0 });
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.discoverModels();
    // `routekit status` reads account state while refreshing providers, so a
    // refresh must never make a healthy member look dark.
    const gate = deferred<DiscoveryResult>();
    provider.discoverModels = () => fromAsync(() => gate.promise);
    const discovering = pool.discoverModels();
    await Promise.resolve();
    assert.deepEqual(pool.snapshot().members[0]?.models, ["gpt-5.3-codex"]);
    assert.equal(pool.statusSnapshot().members[0]?.relayReady, true);
    gate.resolve([{ id: "gpt-5.3-codex" }]);
    await discovering;
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool unions heterogeneous member catalogs and routes only eligible accounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-models-"));
  writeMember(directory, "personal", { accessToken: "token-personal" });
  writeMember(directory, "work", { accessToken: "token-work" });
  const pool = await openAccountSet(
    fakeProvider(
      { refreshes: 0 },
      {
        "token-personal": ["gpt-shared", "gpt-personal"],
        "token-work": ["gpt-shared", "gpt-work"]
      }
    ),
    {
      source: { kind: "directory", path: directory },
      strategy: "round_robin"
    }
  );
  try {
    assert.deepEqual(await pool.discoverModels(), ["gpt-shared", "gpt-personal", "gpt-work"]);
    const personal = await runExecute(pool, "gpt-personal", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    const work = await runExecute(pool, "gpt-work", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await personal.text(), "token-personal");
    assert.equal(await work.text(), "token-work");
    assert.deepEqual(
      pool.snapshot().members.map((member) => [member.id, member.models]),
      [
        ["personal", ["gpt-shared", "gpt-personal"]],
        ["work", ["gpt-shared", "gpt-work"]]
      ]
    );
    await assert.rejects(
      runExecute(pool, "gpt-unknown", () => Promise.resolve(new Response("wrong"))),
      /all codex subscription pool members are unavailable/
    );
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capability conflicts resolve by account order across reversed response timing", async () => {
  for (const completionOrder of [
    ["token-a", "token-b"],
    ["token-b", "token-a"]
  ] as const) {
    const directory = mkdtempSync(join(tmpdir(), "routekit-pool-capabilities-"));
    // Directory-backed pools sort filenames, independently of creation order.
    writeMember(directory, "b", { accessToken: "token-b" });
    writeMember(directory, "a", { accessToken: "token-a" });
    const gates: Record<string, ReturnType<typeof deferred<DiscoveryResult>>> = {
      "token-a": deferred<DiscoveryResult>(),
      "token-b": deferred<DiscoveryResult>()
    };
    const provider = fakeProvider({ refreshes: 0 });
    provider.discoverModels = (credential) =>
      fromAsync(() => gates[credential.accessToken]!.promise);
    const pool = await openAccountSet(provider, {
      source: { kind: "directory", path: directory }
    });
    try {
      const discovering = pool.discoverModels();
      gates[completionOrder[0]]!.resolve(reasoningModel(completionOrder[0]));
      await Promise.resolve();
      gates[completionOrder[1]]!.resolve(reasoningModel(completionOrder[1]));
      await discovering;
      assert.deepEqual(
        pool.reasoningCapabilities("gpt-shared")?.efforts?.map((effort) => effort.id),
        ["token-a"]
      );
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Claude Code pools retain discovered effort and thinking metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-claude-capabilities-"));
  writeMember(directory, "b", { accessToken: "token-b" });
  writeMember(directory, "a", { accessToken: "token-a" });
  const base = fakeProvider({ refreshes: 0 });
  const provider: SubscriptionProvider = {
    ...base,
    requestPath: "/v1/messages",
    loadCredential(path) {
      return base
        .loadCredential(path)
        .pipe(Effect.map((credential) => ({ ...credential, mode: "claude-code" as const })));
    },
    discoverModels(credential) {
      return Effect.succeed([
        {
          id: "claude-fable-5",
          reasoning: {
            status: "supported",
            efforts: [{ id: credential.accessToken === "token-a" ? "low" : "high" }],
            budget: { minTokens: 1_024 },
            adaptive: true,
            wireShape: "anthropic",
            provenance: "provider"
          }
        }
      ]);
    }
  };
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.discoverModels();
    assert.deepEqual(pool.reasoningCapabilities("claude-fable-5"), {
      status: "supported",
      efforts: [{ id: "low" }],
      budget: { minTokens: 1_024 },
      adaptive: true,
      wireShape: "anthropic",
      provenance: "provider"
    });
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capability precedence skips failed and capability-omitting accounts", async () => {
  for (const firstAccount of ["failed", "omitted"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "routekit-pool-capability-fallback-"));
    writeMember(directory, "a", { accessToken: "token-a" });
    writeMember(directory, "b", { accessToken: "token-b" });
    const provider = fakeProvider({ refreshes: 0 });
    provider.discoverModels = (credential) =>
      fromAsync(async () => {
        if (credential.accessToken === "token-b") return reasoningModel("second-account");
        if (firstAccount === "failed") throw new Error("discovery unavailable");
        return [{ id: "gpt-shared" }];
      });
    const pool = await openAccountSet(provider, {
      source: { kind: "directory", path: directory }
    });
    try {
      await pool.discoverModels();
      assert.deepEqual(
        pool.reasoningCapabilities("gpt-shared")?.efforts?.map((effort) => effort.id),
        ["second-account"]
      );
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
