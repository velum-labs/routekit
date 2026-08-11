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
  waitFor
} from "./subscription-pool-fixtures.js";

test("subscription labels are normalized in linear time without credential-derived hashes", () => {
  assert.equal(sanitizeSubscriptionLabel("  Work !!! Account --"), "work-account");
  assert.equal(sanitizeSubscriptionLabel("-".repeat(100_000)), "account");
  assert.equal(sanitizeSubscriptionLabel("Team_A.2"), "team_a.2");
});

test("tracker safely restores hostile member ids into map-backed state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-state-"));
  const statePath = join(directory, ".state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      members: [
        { id: "__proto__", coolingUntil: 123, cooldownRevision: 1 },
        { id: "constructor", coolingUntil: 456, cooldownRevision: 1 }
      ]
    })
  );
  const tracker = new RateLimitTracker(statePath);
  try {
    assert.equal(tracker.coolingUntil("__proto__"), 123);
    tracker.cool("__proto__", 789);
    tracker.cool("prototype", 999);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ id: string; coolingUntil?: number }>;
    };
    assert.ok(Array.isArray(persisted.members));
    assert.equal(persisted.members.find((member) => member.id === "__proto__")?.coolingUntil, 789);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker moves quota and cooldown state to a renamed member", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-rename-state-"));
  const statePath = join(directory, ".state.json");
  const tracker = new RateLimitTracker(statePath, "codex");
  const observedAt = Date.now() / 1000;
  try {
    tracker.update("work", {
      windows: {
        primary: {
          utilization: 0.75,
          observedAt,
          source: "usage"
        }
      },
      observedAt,
      source: "usage",
      completeness: "snapshot"
    });
    tracker.cool("work", 123_456);
    tracker.cool("personal", 999_999);

    tracker.renameMember("work", "personal");

    assert.equal(tracker.limits("work"), undefined);
    assert.equal(tracker.coolingUntil("work"), undefined);
    assert.equal(tracker.limits("personal")?.windows.primary?.utilization, 0.75);
    assert.equal(tracker.coolingUntil("personal"), 123_456);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ id: string; coolingUntil?: number }>;
    };
    assert.deepEqual(
      persisted.members.map((member) => [member.id, member.coolingUntil]),
      [["personal", 123_456]]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker restores canonical partial observations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-window-state-"));
  const statePath = join(directory, ".state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      members: [
        {
          id: "primary",
          limits: {
            windows: {
              five_hour: {
                utilization: 0.2,
                observedAt: Date.now() / 1000,
                source: "headers"
              },
              seven_day_sonnet: {
                utilization: 0.6,
                observedAt: Date.now() / 1000,
                source: "headers"
              }
            },
            observedAt: Date.now() / 1000,
            source: "headers",
            completeness: "partial"
          }
        }
      ]
    })
  );
  const tracker = new RateLimitTracker(statePath, "claude-code");
  try {
    assert.deepEqual(Object.keys(tracker.limits("primary")?.windows ?? {}), [
      "five_hour",
      "seven_day_sonnet"
    ]);
    assert.equal(tracker.limits("primary")?.windows.five_hour?.utilization, 0.2);
    assert.equal(tracker.limits("primary")?.completeness, "partial");

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      members: Array<{ limits?: { windows: Record<string, unknown> } }>;
    };
    assert.deepEqual(Object.keys(persisted.members[0]?.limits?.windows ?? {}), [
      "five_hour",
      "seven_day_sonnet"
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker ignores corrupt unversioned usage state with a diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-legacy-usage-"));
  const statePath = join(directory, ".state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      members: [
        {
          id: "primary",
          limits: {
            windows: {
              "5h": { utilization: 0.4 },
              five_hour: { utilization: 0.2 }
            },
            observedAt: Date.now() / 1000,
            source: "usage"
          }
        }
      ]
    })
  );
  try {
    const tracker = new RateLimitTracker(statePath, "claude-code");
    assert.equal(tracker.limits("primary"), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker rejects noncanonical versioned state with a diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-pool-noncanonical-state-"));
  const statePath = join(directory, ".state.json");
  const diagnostics: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      members: [
        {
          id: "a",
          limits: {
            windows: {
              primary: {
                utilization: 1,
                source: "usage"
              }
            },
            observedAt: Date.now() / 1000,
            source: "usage",
            completeness: "snapshot"
          }
        }
      ]
    })
  );
  try {
    const tracker = new RateLimitTracker(statePath, "codex");
    assert.equal(tracker.limits("a"), undefined);
    assert.equal(diagnostics.length, 1);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker restores fully validated reset credit details", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-tracker-reset-persist-"));
  const path = join(directory, ".state.json");
  const observedAt = 1775000000;
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      members: [
        {
          id: "work",
          limits: {
            windows: {},
            observedAt,
            source: "usage",
            completeness: "snapshot",
            resetCredits: {
              observedAt: observedAt + 1,
              availableCount: 1,
              credits: [
                {
                  id: "RateLimitResetCredit_saved",
                  resetType: "codex_rate_limits",
                  status: "available",
                  grantedAt: observedAt - 10,
                  expiresAt: observedAt + 100,
                  title: "Saved reset",
                  description: "Persisted details"
                }
              ]
            }
          }
        }
      ]
    })
  );
  try {
    assert.deepEqual(new RateLimitTracker(path, "codex").limits("work")?.resetCredits, {
      observedAt: observedAt + 1,
      availableCount: 1,
      credits: [
        {
          id: "RateLimitResetCredit_saved",
          resetType: "codex_rate_limits",
          status: "available",
          grantedAt: observedAt - 10,
          expiresAt: observedAt + 100,
          title: "Saved reset",
          description: "Persisted details"
        }
      ]
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracker restores reset credits using the persisted observation time", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-tracker-reset-migrate-"));
  const path = join(directory, ".state.json");
  const observedAt = 1775000000;
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      members: [
        {
          id: "work",
          limits: {
            windows: {},
            observedAt,
            source: "usage",
            completeness: "snapshot",
            resetCredits: {
              observedAt,
              availableCount: 1,
              credits: [{ id: "RateLimitResetCredit_saved", status: "available" }]
            }
          }
        }
      ]
    })
  );
  try {
    const tracker = new RateLimitTracker(path, "codex");
    assert.deepEqual(tracker.limits("work")?.resetCredits, {
      observedAt,
      availableCount: 1,
      credits: [{ id: "RateLimitResetCredit_saved", status: "available" }]
    });
    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      members: Array<{ limits?: { resetCredits?: { observedAt?: number } } }>;
    };
    assert.equal(persisted.members[0]?.limits?.resetCredits?.observedAt, observedAt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function codexSse(event: string, payload: unknown): Response {
  return new Response(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { "content-type": "text/event-stream" }
  });
}
