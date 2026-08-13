import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type AccountLimits,
  codexSse,
  type DiscoveryResult,
  deferred,
  fakeProvider,
  healthyUsage,
  openAccountSet,
  openActivity,
  persistedCoolingUntil,
  quotaCool,
  RateLimitTracker,
  type ResetCreditSnapshot,
  reasoningModel,
  runExecute,
  runRouteKitEffect,
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

test("execute marks last-selected and keeps serving until buffered body completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-buffer-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const activity = await openActivity({ now: () => 1_000 });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  try {
    const { promise, resolve } = deferred<void>();
    const responsePromise = runExecute(pool, "gpt-5.3-codex", async () => {
      await promise;
      return new Response("buffered-ok");
    });
    await waitFor(() => pool.snapshot().members[0]?.serving === true);
    assert.equal(pool.snapshot().members[0]?.inFlight, 1);
    assert.equal(pool.statusSnapshot().members[0]?.lastSelected, true);
    resolve();
    const response = await responsePromise;
    assert.equal(pool.snapshot().members[0]?.serving, true);
    assert.equal(await response.text(), "buffered-ok");
    assert.equal(pool.snapshot().members[0]?.serving, false);
    assert.equal(pool.snapshot().members[0]?.inFlight, 0);
    assert.equal(pool.snapshot().members[0]?.lastSelectedAt, 1_000);
  } finally {
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed and retried attempts update lastSelected without extending CapacityPool leases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-retry-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  let clock = 10;
  const activity = await openActivity({ now: () => (clock += 1) });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  const seen: string[] = [];
  try {
    const response = await runExecute(pool, "gpt-5.3-codex", (credential) => {
      seen.push(credential.accessToken);
      if (credential.accessToken === "token-a") {
        return Promise.resolve(
          new Response(JSON.stringify({ quota: true }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return Promise.resolve(new Response("ok"));
    });
    assert.equal(await response.text(), "ok");
    assert.deepEqual(seen, ["token-a", "token-b"]);
    const members = pool.snapshot().members;
    assert.equal(members.find((member) => member.id === "a")?.serving, false);
    assert.equal(members.find((member) => member.id === "b")?.lastSelected, true);
    assert.equal(members.find((member) => member.id === "a")?.lastSelected, false);
    assert.equal(members.find((member) => member.id === "b")?.inFlight, 0);
  } finally {
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SSE cancellation releases serving exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-sse-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const activity = await openActivity({ now: () => 55 });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
      }
    });
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        })
    );
    assert.equal(pool.snapshot().members[0]?.serving, true);
    await response.body!.cancel();
    assert.equal(pool.snapshot().members[0]?.serving, false);
    assert.equal(pool.snapshot().members[0]?.inFlight, 0);
    assert.equal(pool.statusSnapshot().members[0]?.lastSelected, true);
  } finally {
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SSE completion releases serving exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-sse-done-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const activity = await openActivity({ now: () => 66 });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
        controller.close();
      }
    });
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        })
    );
    assert.equal(pool.snapshot().members[0]?.serving, true);
    assert.equal(await response.text(), 'data: {"ok":true}\n\n');
    assert.equal(pool.snapshot().members[0]?.serving, false);
    assert.equal(pool.snapshot().members[0]?.inFlight, 0);
    assert.equal(pool.statusSnapshot().members[0]?.lastSelected, true);
    assert.equal(pool.statusSnapshot().members[0]?.serving, false);
  } finally {
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pool lastSelected follows monotonic sequence across concurrent starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-tie-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const now = 500;
  const activity = await openActivity({ now: () => now });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    strategy: "round_robin",
    activity: { resource: activity, ownership: "borrowed" }
  });
  const gates = [deferred<void>(), deferred<void>()];
  try {
    const first = runExecute(pool, "gpt-5.3-codex", async () => {
      await gates[0]!.promise;
      return new Response("one");
    });
    await waitFor(() => pool.snapshot().members.some((member) => member.serving));
    const second = runExecute(pool, "gpt-5.3-codex", async () => {
      await gates[1]!.promise;
      return new Response("two");
    });
    await waitFor(() => pool.snapshot().members.filter((member) => member.serving).length === 2);
    const selected = pool.statusSnapshot().members.find((member) => member.lastSelected);
    assert.ok(selected);
    assert.equal(selected.lastSelectedAt, now);
    gates[0]!.resolve();
    gates[1]!.resolve();
    assert.equal(await (await first).text(), "one");
    assert.equal(await (await second).text(), "two");
    assert.equal(
      pool.statusSnapshot().members.find((member) => member.lastSelected)?.id,
      selected.id
    );
  } finally {
    gates[0]!.resolve();
    gates[1]!.resolve();
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared activity survives across account-set generations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-share-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const activity = await openActivity({ now: () => 77 });
  const first = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  const { promise, resolve } = deferred<void>();
  let pending: Promise<Response> | undefined;
  try {
    pending = runExecute(first, "gpt-5.3-codex", async () => {
      await promise;
      return new Response("from-old-generation");
    });
    await waitFor(() => first.snapshot().members[0]?.serving === true);
    await first.close();

    const second = await openAccountSet(fakeProvider({ refreshes: 0 }), {
      source: { kind: "directory", path: directory },
      activity: { resource: activity, ownership: "borrowed" }
    });
    try {
      assert.equal(second.snapshot().members[0]?.serving, true);
      assert.equal(second.snapshot().members[0]?.lastSelected, true);
      resolve();
      assert.equal(await (await pending).text(), "from-old-generation");
      assert.equal(second.snapshot().members[0]?.serving, false);
    } finally {
      await second.close();
    }
  } finally {
    resolve();
    await pending?.catch(() => undefined);
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage probes and discovery do not mark account selection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-probe-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const activity = await openActivity({ now: () => 9 });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  try {
    await pool.refreshUsage(0);
    await pool.discoverModels();
    assert.equal(pool.snapshot().members[0]?.lastSelected, false);
    assert.equal(pool.snapshot().members[0]?.serving, false);
    assert.equal(pool.snapshot().members[0]?.inFlight, 0);
  } finally {
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent attempts across accounts keep exact-once release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-concurrent-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const activity = await openActivity({ now: () => 123 });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    strategy: "round_robin",
    activity: { resource: activity, ownership: "borrowed" }
  });
  const gates = [deferred<void>(), deferred<void>()];
  try {
    const first = runExecute(pool, "gpt-5.3-codex", async () => {
      await gates[0]!.promise;
      return new Response("one");
    });
    const second = runExecute(pool, "gpt-5.3-codex", async () => {
      await gates[1]!.promise;
      return new Response("two");
    });
    await waitFor(() => pool.snapshot().members.filter((member) => member.serving).length === 2);
    assert.equal(
      pool.snapshot().members.reduce((sum, member) => sum + member.inFlight, 0),
      2
    );
    gates[0]!.resolve();
    assert.equal(await (await first).text(), "one");
    gates[1]!.resolve();
    assert.equal(await (await second).text(), "two");
    assert.equal(
      pool.snapshot().members.reduce((sum, member) => sum + member.inFlight, 0),
      0
    );
  } finally {
    gates[0]!.resolve();
    gates[1]!.resolve();
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("operation abort releases activity without leaking inFlight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-activity-abort-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const activity = await openActivity({ now: () => 5 });
  const pool = await openAccountSet(fakeProvider({ refreshes: 0 }), {
    source: { kind: "directory", path: directory },
    activity: { resource: activity, ownership: "borrowed" }
  });
  try {
    await assert.rejects(
      runExecute(pool, "gpt-5.3-codex", async () => {
        throw new Error("upstream aborted");
      }),
      /upstream aborted/
    );
    assert.equal(pool.snapshot().members[0]?.inFlight, 0);
    assert.equal(pool.snapshot().members[0]?.serving, false);
    assert.equal(pool.snapshot().members[0]?.lastSelected, true);
  } finally {
    await pool.close();
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("buffered pool reroutes HTTP 200 terminal quota failure before returning bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-sse-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  const attempts: string[] = [];
  try {
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      (credential) => {
        attempts.push(credential.accessToken);
        return Promise.resolve(
          credential.accessToken === "token-a"
            ? codexSse("response.failed", {
                response: {
                  error: {
                    type: "usage_limit_reached",
                    code: "weekly",
                    message: "spent",
                    resets_at: Date.now() / 1000 + 3600
                  }
                }
              })
            : codexSse("response.completed", { response: { output: [] } })
        );
      },
      undefined,
      { responseMode: "buffered" }
    );
    const text = await response.text();
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /usage_limit_reached/);
    assert.deepEqual(attempts, ["token-a", "token-b"]);
    assert.ok(pool.snapshot().members.find((member) => member.id === "a")?.coolingUntil);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming pool retries terminal failure only before semantic output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-stream-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  try {
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      (credential) =>
        Promise.resolve(
          credential.accessToken === "token-a"
            ? codexSse("response.failed", {
                response: {
                  error: {
                    type: "usage_limit_reached",
                    message: "spent"
                  }
                }
              })
            : codexSse("response.completed", { response: { output: [] } })
        ),
      undefined,
      { responseMode: "streaming" }
    );
    assert.doesNotMatch(await response.text(), /usage_limit_reached/);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming pool does not replay after semantic output and cools the failed account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-committed-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  const attempts: string[] = [];
  try {
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      (credential) => {
        attempts.push(credential.accessToken);
        return Promise.resolve(
          new Response(
            'event: response.output_text.delta\ndata: {"delta":"visible"}\n\n' +
              'event: response.failed\ndata: {"response":{"error":{"type":"usage_limit_reached","message":"spent"}}}\n\n',
            { headers: { "content-type": "text/event-stream" } }
          )
        );
      },
      undefined,
      { responseMode: "streaming" }
    );
    const text = await response.text();
    assert.match(text, /visible/);
    assert.match(text, /usage_limit_reached/);
    assert.deepEqual(attempts, ["token-a"]);
    assert.ok(pool.snapshot().members.find((member) => member.id === "a")?.coolingUntil);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-commit auth failure never replays but updates auth health for later requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-committed-auth-"));
  writeMember(directory, "a", {
    accessToken: "token-a",
    refreshToken: "refresh-a"
  });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({
    refreshes: 0,
    failRefreshTokens: new Set(["token-a"])
  });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  const attempts: string[] = [];
  try {
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      (credential) => {
        attempts.push(credential.accessToken);
        return Promise.resolve(
          new Response(
            'event: response.output_text.delta\ndata: {"delta":"visible"}\n\n' +
              'event: response.failed\ndata: {"response":{"error":{"type":"invalidated_token","message":"revoked"}}}\n\n',
            { headers: { "content-type": "text/event-stream" } }
          )
        );
      },
      undefined,
      { responseMode: "streaming" }
    );
    assert.match(await response.text(), /visible/);
    assert.deepEqual(attempts, ["token-a"]);
    await waitFor(
      () =>
        pool.statusSnapshot().members.find((member) => member.label === "a")?.upstreamAuthState ===
        "rejected"
    );

    const next = await runExecute(pool, "gpt-5.3-codex", (credential) =>
      Promise.resolve(new Response(credential.accessToken))
    );
    assert.equal(await next.text(), "token-b");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("buffered SSE rejects and cancels bodies over the strict cap without leaks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-cap-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(SUBSCRIPTION_SSE_BUFFER_CAP_BYTES));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancels += 1;
    }
  });
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory }
  });
  try {
    await assert.rejects(
      runExecute(
        pool,
        "gpt-5.3-codex",
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" }
          }),
        undefined,
        { responseMode: "buffered" }
      ),
      new RegExp(`${SUBSCRIPTION_SSE_BUFFER_CAP_BYTES}-byte buffer cap`)
    );
    assert.equal(cancels, 1);
    assert.equal(pool.snapshot().members[0]?.inFlight, 0);
    assert.equal(pool.snapshot().members[0]?.serving, false);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-commit terminal failure penalizes exactly once across later chunks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-penalty-once-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const reset = Date.now() / 1000 + 3600;
  const encoder = new TextEncoder();
  const chunks = [
    'event: response.output_text.delta\ndata: {"delta":"visible"}\n\n',
    `event: response.failed\ndata: {"response":{"error":{"type":"usage_limit_reached","message":"spent","resets_at":${reset}}}}\n\n`,
    'event: response.created\ndata: {"type":"response.created"}\n\n'
  ];
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory }
  });
  try {
    const response = await runExecute(
      pool,
      "gpt-5.3-codex",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks.shift();
              if (chunk === undefined) controller.close();
              else controller.enqueue(encoder.encode(chunk));
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
      undefined,
      { responseMode: "streaming" }
    );
    await response.text();
    const state = JSON.parse(readFileSync(join(directory, ".state.json"), "utf8")) as {
      members: Array<{ cooldownRevision?: number }>;
    };
    assert.equal(state.members[0]?.cooldownRevision, 1);
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all terminal-quota accounts exhaust at the soonest reset without lease leaks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-all-sse-quota-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const soon = Math.floor(Date.now() / 1000) + 120;
  const late = soon + 180;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  try {
    await assert.rejects(
      runExecute(
        pool,
        "gpt-5.3-codex",
        async (credential) =>
          codexSse("response.failed", {
            response: {
              error: {
                type: "usage_limit_reached",
                message: "spent",
                resets_at: credential.accessToken === "token-a" ? soon : late
              }
            }
          }),
        undefined,
        { responseMode: "buffered" }
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(new Date(soon * 1000).toISOString()));
        return true;
      }
    );
    assert.ok(pool.snapshot().members.every((member) => member.inFlight === 0 && !member.serving));
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("abort while waiting for pre-commit SSE releases exactly once without failover", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-prelude-abort-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const aborter = new AbortController();
  const attempts: string[] = [];
  let cancels = 0;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky"
  });
  try {
    const executing = runExecute(
      pool,
      "gpt-5.3-codex",
      async (credential) => {
        attempts.push(credential.accessToken);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              /* Wait for abort before any terminal/semantic event. */
            },
            cancel() {
              cancels += 1;
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      },
      aborter.signal,
      { responseMode: "streaming" }
    );
    await waitFor(() => pool.snapshot().members.some((member) => member.serving));
    aborter.abort(new Error("client cancelled"));
    await assert.rejects(executing, /client cancelled/);
    assert.deepEqual(attempts, ["token-a"]);
    assert.equal(cancels, 1);
    assert.ok(pool.snapshot().members.every((member) => member.inFlight === 0 && !member.serving));
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("acquisition revalidation skips an account cooled by a concurrent request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-stale-acquire-"));
  writeMember(directory, "a", { accessToken: "token-a" });
  writeMember(directory, "b", { accessToken: "token-b" });
  const provider = fakeProvider({ refreshes: 0 });
  provider.parseStreamOutcome = subscriptionProvider("codex").parseStreamOutcome;
  const paused = deferred<void>();
  const resume = deferred<void>();
  let hooks = 0;
  const pool = await openAccountSet(provider, {
    source: { kind: "directory", path: directory },
    strategy: "sticky",
    beforeAcquisitionRevalidation: async ({ label }) => {
      if (label !== "a" || hooks++ !== 0) return;
      paused.resolve();
      await resume.promise;
    }
  });
  const staleAttempts: string[] = [];
  try {
    const stale = runExecute(pool, "gpt-5.3-codex", async (credential) => {
      staleAttempts.push(credential.accessToken);
      return new Response("stale");
    });
    await paused.promise;
    const concurrent = await runExecute(
      pool,
      "gpt-5.3-codex",
      async (credential) =>
        credential.accessToken === "token-a"
          ? codexSse("response.failed", {
              response: { error: { type: "usage_limit_reached", message: "spent" } }
            })
          : codexSse("response.completed", { response: { output: [] } }),
      undefined,
      { responseMode: "buffered" }
    );
    await concurrent.text();
    resume.resolve();
    assert.equal(await (await stale).text(), "stale");
    assert.deepEqual(staleAttempts, ["token-b"]);
  } finally {
    resume.resolve();
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
