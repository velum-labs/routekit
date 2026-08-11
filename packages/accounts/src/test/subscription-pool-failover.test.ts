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
  fakeProvider,
  fullWindowUsageLimits,
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

test("pool transparently rotates from a quota-exhausted member", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  const seen: string[] = [];
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      if (credential.accessToken === "token-a") {
        return Promise.resolve(
          new Response(JSON.stringify({ quota: true }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return Promise.resolve(new Response("OK"));
    });
    assert.equal(await response.text(), "OK");
    assert.deepEqual(seen, ["token-a", "token-b"]);
    assert.ok(pool.snapshot().members.find((member) => member.id === "a")?.coolingUntil);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool proactively moves away from a member over the utilization threshold", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory },
    strategy: "sticky",
    switchThreshold: 0.9
  });
  try {
    const first = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(
        new Response(credential.accessToken, {
          headers: { "x-test-utilization": "0.95" }
        })
      )
    );
    assert.equal(await first.text(), "token-a");
    const second = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await second.text(), "token-b");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool retries a short throttle locally, then tries only one alternate account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  const attemptedAccounts: string[] = [];
  try {
    const response = await pool.execute(
      "gpt-5.3-codex",
      (credential) => {
        seen.push(credential.accessToken);
        return Promise.resolve(
          new Response(JSON.stringify({ quota: false }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        );
      },
      undefined,
      {
        onAttempt: (account) => attemptedAccounts.push(account.seat)
      }
    );
    assert.equal(response.status, 429);
    assert.deepEqual(seen, ["token-a", "token-a", "token-b", "token-b"]);
    assert.equal(attemptedAccounts.length, 4);
    assert.match(attemptedAccounts[0]!, /^seat_[0-9a-f]{16}$/);
    assert.equal(attemptedAccounts[0], attemptedAccounts[1]);
    assert.notEqual(attemptedAccounts[1], attemptedAccounts[2]);
    assert.equal(attemptedAccounts[2], attemptedAccounts[3]);
    assert.doesNotMatch(JSON.stringify(attemptedAccounts), /"a"|"b"/);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool recovers from a persistent account-local throttle on one alternate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const pool = await SubscriptionAccountSet.open(fakeProvider({ refreshes: 0 }), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      return Promise.resolve(
        credential.accessToken === "token-b"
          ? new Response("recovered")
          : new Response(JSON.stringify({ quota: false }), {
              status: 429,
              headers: { "content-type": "application/json" }
            })
      );
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "recovered");
    assert.deepEqual(seen, ["token-a", "token-a", "token-b"]);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool coalesces near-expiry credential refresh before serving", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 - 1
  });
  const state = { refreshes: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential: SubscriptionCredential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await response.text(), "token-a-refreshed");
    assert.equal(state.refreshes, 1);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejected request re-mints the credential and retries once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-reauth-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  const state = { refreshes: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      return Promise.resolve(
        credential.accessToken === "token-a"
          ? new Response("unauthorized", { status: 401 })
          : new Response("served")
      );
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "served");
    assert.deepEqual(seen, ["token-a", "token-a-refreshed"]);
    assert.equal(state.refreshes, 1);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent auth rejections share one refresh without quarantining the refreshed credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-concurrent-reauth-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  const state = { refreshes: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  try {
    const operation = (credential: SubscriptionCredential): Promise<Response> => {
      seen.push(credential.accessToken);
      return Promise.resolve(
        credential.accessToken === "token-a"
          ? new Response("unauthorized", { status: 401 })
          : new Response("served")
      );
    };
    const responses = await Promise.all([
      pool.execute("gpt-5.3-codex", operation),
      pool.execute("gpt-5.3-codex", operation)
    ]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.text())), [
      "served",
      "served"
    ]);
    assert.equal(state.refreshes, 1);
    assert.equal(seen.filter((token) => token === "token-a").length, 2);
    assert.equal(seen.filter((token) => token === "token-a-refreshed").length, 2);
    assert.equal(pool.statusSnapshot().members[0]?.relayReady, true);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unrecoverable auth rejection quarantines one member and reroutes to another", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-reauth-failover-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  writeMember(directory, "b", {
    accessToken: "token-b",
    refreshToken: "refresh-b",
    expiresAt: Date.now() / 1000 + 86_400
  });
  const state = { refreshes: 0, failRefreshTokens: new Set(["token-a"]) };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      return Promise.resolve(
        credential.accessToken === "token-a"
          ? new Response("unauthorized", { status: 401 })
          : new Response("served")
      );
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "served");
    assert.deepEqual(seen, ["token-a", "token-b"]);
    assert.equal(state.refreshes, 1);

    const rejected = pool.statusSnapshot().members.find((member) => member.label === "a");
    assert.equal(rejected?.credentialValid, true);
    assert.equal(rejected?.poolEligible, false);
    assert.equal(rejected?.relayReady, false);
    assert.deepEqual(rejected?.readinessReasons, [{ code: "provider_auth_rejected", status: 401 }]);

    const subsequent = await pool.execute("gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      return Promise.resolve(new Response("served again"));
    });
    assert.equal(await subsequent.text(), "served again");
    assert.deepEqual(seen, ["token-a", "token-b", "token-b"]);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credentials that stay rejected are quarantined and return an actionable re-login error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-reauth-fail-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  writeMember(directory, "b", {
    accessToken: "token-b",
    refreshToken: "refresh-b",
    expiresAt: Date.now() / 1000 + 86_400
  });
  const state = { refreshes: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const seen: string[] = [];
  try {
    await assert.rejects(
      pool.execute("gpt-5.3-codex", (credential) => {
        seen.push(credential.accessToken);
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionAccountSetAuthError);
        assert.equal(error.failure.category, "auth_permanent");
        assert.match(error.message, /remove and re-login each rejected codex account/);
        return true;
      }
    );
    assert.deepEqual(seen, ["token-a", "token-a-refreshed", "token-b", "token-b-refreshed"]);
    assert.equal(state.refreshes, 2);

    await assert.rejects(
      pool.execute("gpt-5.3-codex", (credential) => {
        seen.push(credential.accessToken);
        return Promise.resolve(new Response("must not run"));
      }),
      SubscriptionAccountSetAuthError
    );
    assert.equal(seen.length, 4);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("temporary auth refresh failure enters backoff and reroutes to another member", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-auth-backoff-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.refresh = async () => {
    throw new SubscriptionRefreshError({
      kind: "transient",
      failureKind: "provider",
      retryAfter: 30
    });
  };
  const pool = await SubscriptionAccountSet.open(provider, {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    const response = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(
        credential.accessToken === "token-a"
          ? new Response("unauthorized", { status: 401 })
          : new Response("served")
      )
    );
    assert.equal(await response.text(), "served");
    const member = pool.statusSnapshot().members.find((candidate) => candidate.label === "a");
    assert.equal(member?.upstreamAuthState, "backoff");
    assert.equal(member?.poolEligible, false);
    assert.equal(member?.readinessReasons?.[0]?.code, "provider_auth_backoff");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model-scoped 403 reroutes only that model while request-scoped 403 passes through", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-forbidden-scope-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const state = { refreshes: 0 };
  const pool = await SubscriptionAccountSet.open(fakeProvider(state), {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  try {
    await pool.discoverModels();
    const modelAttempts: string[] = [];
    const modelResponse = await pool.execute("gpt-5.3-codex", (credential) => {
      modelAttempts.push(credential.accessToken);
      return Promise.resolve(
        credential.accessToken === "token-a"
          ? Response.json({ error: { code: "model_access_denied" } }, { status: 403 })
          : new Response("served")
      );
    });
    assert.equal(await modelResponse.text(), "served");
    assert.deepEqual(modelAttempts, ["token-a", "token-b"]);
    assert.deepEqual(pool.snapshot().members.find((member) => member.label === "a")?.models, []);
    assert.equal(state.refreshes, 0);

    const requestResponse = await pool.execute(undefined, () =>
      Promise.resolve(Response.json({ error: { code: "policy_denied" } }, { status: 403 }))
    );
    assert.equal(requestResponse.status, 403);
    assert.equal(state.refreshes, 0);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new requests route around a shared recovery and caller abort does not cancel it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-recovery-routing-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    expiresAt: Date.now() / 1000 + 86_400
  });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  const refreshing = deferred<SubscriptionCredential>();
  let refreshStarted = false;
  provider.refresh = () => {
    refreshStarted = true;
    return refreshing.promise;
  };
  const pool = await SubscriptionAccountSet.open(provider, {
    mode: "codex",
    source: { kind: "directory", path: directory }
  });
  const controller = new AbortController();
  try {
    const recovering = pool.execute(
      "gpt-5.3-codex",
      (credential) =>
        Promise.resolve(
          credential.accessToken === "token-a"
            ? new Response("unauthorized", { status: 401 })
            : new Response("probation")
        ),
      controller.signal
    );
    await waitFor(() => refreshStarted);

    const routed = await pool.execute("gpt-5.3-codex", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await routed.text(), "token-b");

    controller.abort(new Error("caller stopped"));
    refreshing.resolve({
      mode: "codex",
      sourcePath: join(directory, "a.json"),
      accessToken: "token-a-refreshed",
      refreshToken: "refresh-a",
      expiresAt: Date.now() / 1000 + 3_600
    });
    await assert.rejects(recovering, /caller stopped/);
    assert.equal(
      pool.statusSnapshot().members.find((member) => member.label === "a")?.upstreamAuthState,
      "unknown"
    );
  } finally {
    refreshing.reject(new Error("test closed"));
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool still attempts a sole member over threshold when credits remain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-credits-"));
  writeMember(directory, "velum", { accessToken: "token-velum" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.fetchUsage = async () => fullWindowUsageLimits(true);
  const pool = await SubscriptionAccountSet.open(provider, {
    mode: "codex",
    source: { kind: "directory", path: directory },
    strategy: "capacity_weighted",
    switchThreshold: 0.9
  });
  const attemptedAccounts: string[] = [];
  try {
    await pool.refreshUsage(0);
    const response = await pool.execute(
      "gpt-5.3-codex",
      (credential) => Promise.resolve(new Response(credential.accessToken)),
      undefined,
      { onAttempt: (account) => attemptedAccounts.push(account.seat) }
    );
    assert.equal(await response.text(), "token-velum");
    assert.equal(attemptedAccounts.length, 1);
    assert.equal(pool.statusSnapshot().members[0]?.poolEligible, true);
    assert.equal(pool.statusSnapshot().members[0]?.relayReady, true);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool rejects a sole member over threshold locally when credits are gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-no-credits-"));
  writeMember(directory, "velum", { accessToken: "token-velum" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.fetchUsage = async () => fullWindowUsageLimits(false);
  const pool = await SubscriptionAccountSet.open(provider, {
    mode: "codex",
    source: { kind: "directory", path: directory },
    strategy: "capacity_weighted",
    switchThreshold: 0.9
  });
  const attemptedAccounts: string[] = [];
  try {
    await pool.refreshUsage(0);
    await assert.rejects(
      pool.execute(
        "gpt-5.3-codex",
        () => Promise.resolve(new Response("should-not-run")),
        undefined,
        { onAttempt: (account) => attemptedAccounts.push(account.seat) }
      ),
      /all codex subscription pool members are unavailable until/
    );
    assert.deepEqual(attemptedAccounts, []);
    assert.equal(pool.statusSnapshot().members[0]?.poolEligible, false);
    assert.equal(pool.statusSnapshot().members[0]?.relayReady, false);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
