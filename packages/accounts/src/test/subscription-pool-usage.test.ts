import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AccountActivityCoordinator,
  type AccountLimits,
  type DiscoveryResult,
  deferred,
  type FakeProviderState,
  fakeProvider,
  healthyUsage,
  persistedCoolingUntil,
  quotaCool,
  RateLimitTracker,
  type ResetCreditSnapshot,
  reasoningModel,
  SUBSCRIPTION_SSE_BUFFER_CAP_BYTES,
  SubscriptionAccountSet,
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

test("authoritative usage snapshots replace partial header windows", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-snapshot-"));
  const statePath = join(directory, ".state.json");
  const tracker = new RateLimitTracker(statePath, "claude-code");
  const headerObservedAt = Date.now() / 1000 - 60;
  const usageObservedAt = Date.now() / 1000;
  try {
    tracker.update("primary", {
      windows: {
        "5h": {
          utilization: 0.4,
          observedAt: headerObservedAt,
          source: "headers"
        },
        "7d-opus": {
          utilization: 0.8,
          observedAt: headerObservedAt,
          source: "headers"
        }
      },
      observedAt: headerObservedAt,
      source: "headers",
      completeness: "partial"
    });
    tracker.update("primary", {
      windows: {
        five_hour: {
          utilization: 0.2,
          observedAt: usageObservedAt,
          source: "usage"
        }
      },
      observedAt: usageObservedAt,
      source: "usage",
      completeness: "snapshot"
    });

    const limits = tracker.limits("primary");
    assert.deepEqual(Object.keys(limits?.windows ?? {}), ["five_hour"]);
    assert.equal(limits?.windows.five_hour?.utilization, 0.2);
    assert.equal(limits?.completeness, "snapshot");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a valid observation clears diagnostics from the previous partial update", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-diagnostics-"));
  const tracker = new RateLimitTracker(join(directory, ".state.json"), "codex");
  const observedAt = Date.now() / 1000;
  try {
    tracker.update("a", {
      windows: {},
      diagnostics: [
        {
          code: "invalid_utilization",
          window: "codex:primary",
          field: "used_percent"
        }
      ],
      observedAt,
      source: "headers",
      completeness: "partial"
    });
    assert.equal(tracker.limits("a")?.diagnostics?.length, 1);

    tracker.update("a", {
      windows: {
        "codex:primary": {
          utilization: 0.01,
          observedAt: observedAt + 1,
          source: "headers"
        }
      },
      observedAt: observedAt + 1,
      source: "headers",
      completeness: "partial"
    });
    assert.equal(tracker.limits("a")?.diagnostics, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a recent partial observation does not suppress an authoritative probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-partial-probe-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const state: FakeProviderState = { refreshes: 0, usageCalls: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.execute("gpt-5.3-codex", () =>
      Promise.resolve(
        new Response("ok", {
          headers: { "x-test-utilization": "0.4" }
        })
      )
    );
    assert.equal(pool.snapshot().members[0]?.limits?.completeness, "partial");

    await pool.refreshUsage();
    assert.equal(state.usageCalls, 1);
    assert.equal(pool.snapshot().members[0]?.limits?.completeness, "snapshot");
    assert.deepEqual(Object.keys(pool.snapshot().members[0]?.limits?.windows ?? {}), []);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage refresh throttles failed provider probes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-usage-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const state: FakeProviderState = {
    refreshes: 0,
    usageCalls: 0,
    failUsage: true
  };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.refreshUsage();
    await pool.refreshUsage();
    assert.equal(state.usageCalls, 1);

    await pool.refreshUsage(0);
    assert.equal(state.usageCalls, 2);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quota cooldown is cleared by healthy authoritative usage in memory and persistence", async () => {
  for (const mode of ["codex", "claude-code"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `routekit-pool-reconcile-${mode}-`));
    writeMember(directory, "a", { accessToken: "token-a" });
    const state: FakeProviderState = { refreshes: 0 };
    const pool = await SubscriptionAccountSet.open(fakeProvider(state, {}, mode), {
      mode,
      source: { kind: "directory", path: directory }
    });
    try {
      await quotaCool(pool, mode === "codex" ? "gpt-5.3-codex" : "claude-sonnet");
      assert.ok(pool.snapshot().members[0]?.coolingUntil);
      state.usageLimits = healthyUsage();
      await pool.refreshUsage(0);
      assert.equal(pool.snapshot().members[0]?.coolingUntil, undefined);
      const persisted = JSON.parse(await readFile(join(directory, ".state.json"), "utf8")) as {
        members: Array<{ coolingUntil?: number; cooldownRevision?: number }>;
      };
      assert.equal(persisted.members[0]?.coolingUntil, undefined);
      assert.ok((persisted.members[0]?.cooldownRevision ?? 0) >= 2);
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("authoritative cooldown recovery survives close and reopen with legacy migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-reopen-recovery-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const statePath = join(directory, ".state.json");
  const coolingUntil = Date.now() / 1000 + 3_600;
  writeFileSync(statePath, JSON.stringify({ members: [{ id: "a", coolingUntil }] }));
  const state: FakeProviderState = { refreshes: 0, usageLimits: healthyUsage() };
  const first = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    assert.equal(first.snapshot().members[0]?.coolingUntil, coolingUntil);
    const migrated = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ coolingUntil?: number; cooldownRevision?: number }>;
    };
    assert.equal(migrated.members[0]?.cooldownRevision, 1);

    await first.refreshUsage(0);
    assert.equal(first.snapshot().members[0]?.coolingUntil, undefined);
  } finally {
    await first.close();
  }

  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    members: Array<{ coolingUntil?: number; cooldownRevision?: number }>;
  };
  assert.equal(persisted.members[0]?.coolingUntil, undefined);
  assert.equal(persisted.members[0]?.cooldownRevision, 2);

  const reopened = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    const member = reopened.statusSnapshot().members[0];
    assert.equal(member?.coolingUntil, undefined);
    assert.equal(member?.poolEligible, true);
    assert.equal(member?.relayReady, true);
    assert.deepEqual(member?.readinessReasons, []);
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial, exhausted, and failed usage probes preserve quota cooldown", async () => {
  for (const scenario of ["partial", "exhausted", "failure"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `routekit-pool-preserve-${scenario}-`));
    writeMember(directory, "a", { accessToken: "token-a" });
    const state: FakeProviderState = { refreshes: 0 };
    const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
      mode: "codex",
      source: { kind: "directory", path: directory }
    });
    try {
      await quotaCool(pool, "gpt-5.3-codex");
      const original = pool.snapshot().members[0]?.coolingUntil;
      if (scenario === "partial") state.usageLimits = healthyUsage("partial");
      if (scenario === "exhausted") state.usageLimits = fullWindowUsageLimits(false);
      if (scenario === "failure") state.failUsage = true;
      await pool.refreshUsage(0);
      assert.equal(pool.snapshot().members[0]?.coolingUntil, original);
      const persisted = JSON.parse(await readFile(join(directory, ".state.json"), "utf8")) as {
        members: Array<{ coolingUntil?: number }>;
      };
      assert.equal(persisted.members[0]?.coolingUntil, original);
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a probe racing a new quota failure preserves the newer cooldown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-reconcile-race-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const state: FakeProviderState = { refreshes: 0 };
  const provider = fakeProvider(state);
  const usage = deferred<AccountLimits>();
  provider.fetchUsage = () => usage.promise;
  const pool = await SubscriptionAccountSet.open(provider, {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    const probing = pool.refreshUsage(0);
    await Promise.resolve();
    await quotaCool(pool, "gpt-5.3-codex");
    const newerCooldown = pool.snapshot().members[0]?.coolingUntil;

    usage.resolve(healthyUsage());
    await probing;

    assert.equal(pool.snapshot().members[0]?.coolingUntil, newerCooldown);
    assert.equal(await persistedCoolingUntil(join(directory, ".state.json"), "a"), newerCooldown);
  } finally {
    usage.resolve(healthyUsage());
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fullWindowUsageLimits(hasCredits: boolean): AccountLimits {
  const observedAt = Date.now() / 1000;
  return {
    windows: {
      primary: {
        utilization: 1,
        resetsAt: observedAt + 604_800,
        observedAt,
        source: "usage"
      }
    },
    credits: { hasCredits, unlimited: false },
    observedAt,
    source: "usage",
    completeness: "snapshot"
  };
}

test("candidate generation probe preserves newer cooldown from draining generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-generation-race-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const candidateProvider = fakeProvider({ refreshes: 0 });
  const usage = deferred<AccountLimits>();
  candidateProvider.fetchUsage = () => usage.promise;
  const draining = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const candidate = await SubscriptionAccountSet.open(candidateProvider, {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    const probing = candidate.refreshUsage(0);
    await Promise.resolve();
    await quotaCool(draining, "gpt-5.3-codex");
    const newerCooldown = draining.snapshot().members[0]?.coolingUntil;

    usage.resolve(healthyUsage());
    await probing;

    assert.equal(candidate.snapshot().members[0]?.coolingUntil, newerCooldown);
    assert.equal(candidate.statusSnapshot().members[0]?.poolEligible, false);
    assert.equal(await persistedCoolingUntil(join(directory, ".state.json"), "a"), newerCooldown);
  } finally {
    usage.resolve(healthyUsage());
    await candidate.close();
    await draining.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new generation adopts an operator edit that removed a cooldown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-operator-edit-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const statePath = join(directory, ".state.json");
  const coolingUntil = Date.now() / 1000 + 86_400;
  writeFileSync(statePath, JSON.stringify({ members: [{ id: "a", coolingUntil }] }));
  const stale = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    assert.equal(stale.snapshot().members[0]?.coolingUntil, coolingUntil);
    writeFileSync(statePath, JSON.stringify({ members: [{ id: "a" }] }));

    const reloaded = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
      mode: "codex",
      source: { kind: "directory", path: directory }
    });
    try {
      assert.equal(reloaded.snapshot().members[0]?.coolingUntil, undefined);
      assert.equal(reloaded.statusSnapshot().members[0]?.poolEligible, true);
      assert.equal(await persistedCoolingUntil(statePath, "a"), undefined);
    } finally {
      await reloaded.close();
    }
  } finally {
    await stale.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("redeem reset preserves a newer cooldown created while consume is pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-redeem-race-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const state: FakeProviderState = { refreshes: 0 };
  const provider = fakeProvider(state);
  const consumed =
    deferred<Awaited<ReturnType<NonNullable<SubscriptionProvider["consumeResetCredit"]>>>>();
  provider.consumeResetCredit = () => consumed.promise;
  const pool = await SubscriptionAccountSet.open(provider, {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await quotaCool(pool, "gpt-5.3-codex");
    const redeeming = pool.redeemResetCredit({
      label: "a",
      creditId: "credit-a",
      redeemRequestId: "redeem-race"
    });
    await Promise.resolve();
    const tracker = new RateLimitTracker(join(directory, ".state.json"), "codex");
    const newerCooldown = Date.now() / 1000 + 7_200;
    tracker.cool("a", newerCooldown, { model: "gpt-5.3-codex" });
    consumed.resolve({
      ok: true,
      code: "reset",
      redeemRequestId: "redeem-race",
      creditId: "credit-a"
    });
    await redeeming;

    assert.equal(pool.snapshot().members[0]?.coolingUntil, newerCooldown);
    assert.equal(tracker.coolingUntil("a"), newerCooldown);
    assert.equal(await persistedCoolingUntil(join(directory, ".state.json"), "a"), newerCooldown);
  } finally {
    consumed.reject(new Error("test closed"));
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conditional refresh reset preserves newer cooldown while clearing stale limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-refresh-race-"));
  const tracker = new RateLimitTracker(join(directory, ".state.json"), "codex");
  try {
    tracker.update("a", healthyUsage());
    const expectedRevision = tracker.cool("a", Date.now() / 1000 + 3_600);
    const newerCooldown = Date.now() / 1000 + 7_200;
    tracker.cool("a", newerCooldown);

    assert.equal(tracker.resetAfterRefresh("a", expectedRevision), false);
    assert.equal(tracker.coolingUntil("a"), newerCooldown);
    assert.equal(tracker.limits("a"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy model-less Claude cooldown checks every family window", async () => {
  for (const scenario of ["exhausted", "healthy"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `routekit-pool-claude-legacy-${scenario}-`));
    writeMember(directory, "a", { accessToken: "token-a" });
    const statePath = join(directory, ".state.json");
    const coolingUntil = Date.now() / 1000 + 3_600;
    writeFileSync(statePath, JSON.stringify({ members: [{ id: "a", coolingUntil }] }));
    const observedAt = Date.now() / 1000;
    const usageLimits: AccountLimits = {
      windows: {
        seven_day_sonnet: {
          utilization: scenario === "exhausted" ? 1 : 0.1,
          observedAt,
          source: "usage"
        }
      },
      observedAt,
      source: "usage",
      completeness: "snapshot"
    };
    const pool = await SubscriptionAccountSet.open(
      fakeProvider({ refreshes: 0, usageLimits }, {}, "claude-code"),
      { mode: "claude-code", source: { kind: "directory", path: directory } }
    );
    try {
      await pool.refreshUsage(0);
      assert.equal(
        pool.snapshot().members[0]?.coolingUntil,
        scenario === "exhausted" ? coolingUntil : undefined
      );
      assert.equal(
        await persistedCoolingUntil(statePath, "a"),
        scenario === "exhausted" ? coolingUntil : undefined
      );
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("redeeming a banked reset refreshes windows and clears cooling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-redeem-"));
  writeMember(directory, "work", { accessToken: "token-work" });
  const observedAt = Date.now() / 1000;
  const state: FakeProviderState = {
    refreshes: 0,
    usageCalls: 0,
    consumeCalls: 0,
    usageLimits: {
      windows: {
        primary: {
          utilization: 0.5,
          resetsAt: observedAt + 3600,
          observedAt,
          source: "usage"
        }
      },
      resetCredits: {
        observedAt,
        availableCount: 1,
        credits: [
          {
            id: "RateLimitResetCredit_work",
            status: "available",
            expiresAt: observedAt + 86400
          }
        ]
      },
      observedAt,
      source: "usage",
      completeness: "snapshot"
    },
    resetCredits: {
      observedAt,
      availableCount: 1,
      credits: [
        {
          id: "RateLimitResetCredit_work",
          status: "available",
          expiresAt: observedAt + 86400
        }
      ]
    }
  };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory },
    switchThreshold: 0.9
  });
  try {
    await pool.refreshUsage(0);
    await assert.rejects(
      pool.execute(
        "gpt-5.3-codex",
        async () => new Response(JSON.stringify({ quota: true }), { status: 429 })
      ),
      /unavailable/
    );
    assert.ok((pool.snapshot().members[0]?.coolingUntil ?? 0) > Date.now() / 1000);

    const result = await pool.redeemResetCredit({
      label: "work",
      redeemRequestId: "idem-1"
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, "reset");
    assert.equal(result.creditId, "RateLimitResetCredit_work");
    assert.equal(state.consumeCalls, 1);
    assert.equal(pool.snapshot().members[0]?.coolingUntil, undefined);
    assert.equal(pool.snapshot().members[0]?.limits?.windows.primary?.utilization, 0.01);
    assert.equal(pool.snapshot().members[0]?.limits?.resetCredits?.availableCount, 0);

    const response = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await response.text(), "token-work");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dedicated reset refresh preserves stale state on failure and clears on empty", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-reset-refresh-"));
  writeMember(directory, "work", { accessToken: "token-work" });
  const observedAt = Date.now() / 1000;
  const detailed = {
    observedAt,
    availableCount: 1,
    credits: [{ id: "RateLimitResetCredit_stale", status: "available", title: "Stale reset" }]
  } satisfies ResetCreditSnapshot;
  const state: FakeProviderState = {
    refreshes: 0,
    resetCredits: detailed,
    usageLimits: {
      windows: {
        primary: {
          utilization: 0.5,
          observedAt,
          source: "usage"
        }
      },
      // Weaker embedded count-only payload must not win when dedicated listing fails.
      resetCredits: { observedAt, availableCount: 1 },
      observedAt,
      source: "usage",
      completeness: "snapshot"
    }
  };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.listResetCredits("work");
    assert.deepEqual(pool.snapshot().members[0]?.limits?.resetCredits, detailed);

    state.failResetCredits = true;
    await pool.probe();
    assert.deepEqual(pool.snapshot().members[0]?.limits?.resetCredits, detailed);

    state.failResetCredits = false;
    state.resetCredits = { observedAt: observedAt + 1, availableCount: 0, credits: [] };
    await pool.listResetCredits("work");
    assert.deepEqual(pool.snapshot().members[0]?.limits?.resetCredits, state.resetCredits);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
