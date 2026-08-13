import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startGateway } from "@velum-labs/routekit-gateway";

import {
  closeSubscriptionAccountSets,
  openSubscriptionAccountSets,
  type SubscriptionAccountSetSnapshot,
  SubscriptionProxyClient,
  SubscriptionProxyClientError,
  snapshotsToUsage,
  startSubscriptionProxy,
  subscriptionUsageResponseSchema
} from "../index.js";
import { openActivity, openAuth, runRouteKitEffect } from "./subscription-pool-fixtures.js";

const FUTURE_EXPIRY_MS = Date.now() + 3_600_000;

function claudeAccountDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "routekit-sdk-"));
  const observedAt = Date.now() / 1000;
  writeFileSync(
    join(directory, "primary.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "oauth-primary", expiresAt: FUTURE_EXPIRY_MS }
    })
  );
  writeFileSync(
    join(directory, ".state.json"),
    JSON.stringify({
      version: 1,
      members: [
        {
          id: "primary",
          limits: {
            windows: {
              five_hour: {
                utilization: 0.25,
                observedAt,
                source: "usage"
              }
            },
            observedAt,
            source: "usage",
            completeness: "snapshot"
          }
        }
      ]
    })
  );
  return directory;
}

test("startSubscriptionProxy serves a typed client over the usage wire contract", async () => {
  const directory = claudeAccountDir();
  const proxy = await startSubscriptionProxy({
    accounts: { "claude-code": { source: { kind: "directory", path: directory } } },
    host: "127.0.0.1",
    port: 0,
    token: "proxy-secret",
    gatewayFactory: startGateway
  });
  try {
    assert.deepEqual([...proxy.providers], ["anthropic"]);

    const client = SubscriptionProxyClient.open({ baseUrl: proxy.url(), token: "proxy-secret" });
    assert.equal(await client.health(), true);

    const usage = await client.usage();
    assert.equal(usage.accountSets.length, 1);
    assert.equal(usage.accountSets[0]?.mode, "claude-code");
    assert.equal(usage.accountSets[0]?.members.length, 1);
    assert.equal(usage.accountSets[0]?.members[0]?.label, "primary");
    assert.equal(usage.accountSets[0]?.members[0]?.serving, false);
    assert.equal(usage.accountSets[0]?.members[0]?.inFlight, 0);
    assert.equal(usage.accountSets[0]?.members[0]?.lastSelected, false);

    // The in-process snapshot and the over-the-wire response agree.
    assert.deepEqual(JSON.parse(JSON.stringify(proxy.usage())), usage);

    // The wrong ingress token is rejected before any account is touched.
    const unauthorized = SubscriptionProxyClient.open({ baseUrl: proxy.url(), token: "wrong" });
    await assert.rejects(
      () => unauthorized.usage(),
      (error: unknown) => error instanceof SubscriptionProxyClientError && error.status === 401
    );
  } finally {
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startSubscriptionProxy fails fast when no account is available", async () => {
  const empty = mkdtempSync(join(tmpdir(), "routekit-sdk-empty-"));
  try {
    await assert.rejects(() =>
      startSubscriptionProxy({
        accounts: { "claude-code": { source: { kind: "directory", path: empty } } },
        port: 0,
        gatewayFactory: startGateway
      })
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("proxy startup failure closes owned resources after a gateway factory rejects", async () => {
  const directory = claudeAccountDir();
  const activity = await openActivity();
  try {
    await assert.rejects(
      startSubscriptionProxy({
        accounts: { "claude-code": { source: { kind: "directory", path: directory } } },
        activity: { resource: activity, ownership: "owned" },
        gatewayFactory: async () => {
          throw new Error("injected gateway startup failure");
        }
      }),
      /injected gateway startup failure/
    );
    assert.throws(() => activity.beginAttempt("claude-code:primary"), /coordinator is closed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("proxy startup failure leaves borrowed coordinators open", async () => {
  const directory = claudeAccountDir();
  const activity = await openActivity();
  try {
    await assert.rejects(
      startSubscriptionProxy({
        accounts: { "claude-code": { source: { kind: "directory", path: directory } } },
        activity: { resource: activity, ownership: "borrowed" },
        gatewayFactory: async () => {
          throw new Error("injected gateway startup failure");
        }
      }),
      /injected gateway startup failure/
    );
    const release = activity.beginAttempt("claude-code:primary");
    release();
  } finally {
    await runRouteKitEffect(activity.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful account-set startup transfers owned coordinators to the returned sets", async () => {
  const directory = claudeAccountDir();
  const activity = await openActivity();
  const authHealth = await openAuth();
  try {
    const sets = await openSubscriptionAccountSets(
      { "claude-code": { source: { kind: "directory", path: directory } } },
      { resource: activity, ownership: "owned" },
      { resource: authHealth, ownership: "owned" }
    );

    await closeSubscriptionAccountSets(sets);
    await closeSubscriptionAccountSets(sets);

    assert.throws(() => activity.beginAttempt("claude-code:primary"), /coordinator is closed/);
    assert.throws(
      () => authHealth.register("claude-code:primary", "fingerprint"),
      /coordinator is closed/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the usage wire schema round-trips an account-set snapshot", () => {
  const snapshot: SubscriptionAccountSetSnapshot = {
    mode: "codex",
    strategy: "capacity_weighted",
    switchThreshold: 0.9,
    members: [
      {
        id: "work",
        mode: "codex",
        label: "work",
        sourcePath: "/tmp/work.json",
        serving: false,
        inFlight: 0,
        lastSelectedAt: 1_776_000_000_000,
        lastSelected: true,
        credentialValid: true,
        poolEligible: false,
        relayReady: false,
        readinessReasons: [
          { code: "cooldown_active", until: 1_777_000_000 },
          {
            code: "quota_switch_threshold",
            window: "codex:primary",
            utilization: 0.95,
            switchThreshold: 0.9
          }
        ],
        models: ["gpt-5.5"],
        limits: {
          diagnostics: [
            {
              code: "invalid_utilization",
              window: "codex:secondary",
              field: "used_percent"
            }
          ],
          windows: {
            "codex:primary": {
              utilization: 0.95,
              resetsAt: 1_777_000_000,
              observedAt: 1_776_000_000,
              source: "headers"
            }
          },
          resetCredits: {
            observedAt: 1_776_000_100,
            availableCount: 1,
            credits: [
              {
                id: "RateLimitResetCredit_wire",
                status: "available",
                title: "Wire reset",
                expiresAt: 1_777_000_000
              }
            ]
          },
          observedAt: 1_776_000_000,
          source: "headers",
          completeness: "partial"
        }
      }
    ]
  };
  const parsed = subscriptionUsageResponseSchema.parse(snapshotsToUsage([snapshot, undefined]));
  assert.deepEqual(parsed.accountSets, [snapshot]);
  assert.equal(parsed.accountSets[0]?.members[0]?.serving, false);
  assert.equal(parsed.accountSets[0]?.members[0]?.inFlight, 0);
  assert.equal(parsed.accountSets[0]?.members[0]?.lastSelected, true);
  assert.equal(parsed.accountSets[0]?.members[0]?.lastSelectedAt, 1_776_000_000_000);
  assert.equal(
    parsed.accountSets[0]?.members[0]?.limits?.resetCredits?.credits?.[0]?.id,
    "RateLimitResetCredit_wire"
  );
  assert.deepEqual(
    parsed.accountSets[0]?.members[0]?.readinessReasons,
    snapshot.members[0]?.readinessReasons
  );

  const older = structuredClone(snapshot);
  delete older.members[0]?.readinessReasons;
  assert.equal(
    subscriptionUsageResponseSchema.parse(snapshotsToUsage([older])).accountSets[0]?.members[0]
      ?.readinessReasons,
    undefined
  );
});
