import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountActivityCoordinator } from "@velum-labs/routekit-accounts";
import type { RouteKitCallInspection } from "@velum-labs/routekit-control";

import {
  aggregateInspections,
  defaultLeaderboardWindow,
  LeaderboardRollupStore
} from "../leaderboard.js";

function inspection(input: {
  callId: string;
  principal?: { tokenId: string; label?: string };
  model?: string;
  provider?: string;
  status?: RouteKitCallInspection["status"];
  tokens?: number;
  cost?: number;
  unknownCost?: boolean;
  latencyMs?: number;
  startedAt?: string;
}): RouteKitCallInspection {
  return {
    callId: input.callId,
    status: input.status ?? "succeeded",
    effectiveModel: input.model ?? "openai/gpt-5.5",
    provider: input.provider ?? "openai",
    billingMode: "api_key",
    ...(input.principal !== undefined ? { principal: input.principal } : {}),
    retries: { attempts: 1, total: 0, accountFailovers: 0 },
    usage: {
      prompt_tokens: input.tokens ?? 10,
      completion_tokens: 5,
      total_tokens: (input.tokens ?? 10) + 5
    },
    cost: {
      ...(input.cost !== undefined ? { estimateUsd: input.cost } : {}),
      unknownUsage: false,
      unknownCost: input.unknownCost ?? false
    },
    timing: {
      startedAt: input.startedAt ?? "2026-07-27T10:00:00.000Z",
      finishedAt: input.startedAt ?? "2026-07-27T10:00:01.000Z",
      latencyMs: input.latencyMs ?? 1_000
    }
  };
}

test("defaultLeaderboardWindow uses the longest supported durable window", () => {
  assert.equal(defaultLeaderboardWindow({ durable: false, durableRetentionDays: 14 }), "live");
  assert.equal(defaultLeaderboardWindow({ durable: true, durableRetentionDays: 1 }), "24h");
  assert.equal(defaultLeaderboardWindow({ durable: true, durableRetentionDays: 6 }), "24h");
  assert.equal(defaultLeaderboardWindow({ durable: true, durableRetentionDays: 7 }), "7d");
});

test("aggregateInspections ranks principals by cost and keeps unknown cost visible", () => {
  const result = aggregateInspections(
    [
      inspection({
        callId: "a",
        principal: { tokenId: "tok_a", label: "alice" },
        cost: 0.5
      }),
      inspection({
        callId: "b",
        principal: { tokenId: "tok_b", label: "bob" },
        cost: 1.25
      }),
      inspection({
        callId: "c",
        principal: { tokenId: "tok_a", label: "alice" },
        unknownCost: true
      }),
      inspection({
        callId: "d",
        model: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        cost: 9
      })
    ],
    { by: "principal", sort: "cost", limit: 10 }
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.key, "tok_b");
  assert.equal(result.rows[0]?.estimateUsd, 1.25);
  assert.equal(result.rows[1]?.key, "tok_a");
  assert.equal(result.rows[1]?.estimateUsd, 0.5);
  assert.equal(result.rows[1]?.unknownCostCount, 1);
  assert.equal(result.sampleSize, 4);
});

test("aggregateInspections can rank by model and sort by requests", () => {
  const result = aggregateInspections(
    [
      inspection({ callId: "1", model: "openai/a", cost: 1 }),
      inspection({ callId: "2", model: "openai/a", cost: 1 }),
      inspection({ callId: "3", model: "openai/b", cost: 5 })
    ],
    { by: "model", sort: "requests", limit: 1 }
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.key, "openai/a");
  assert.equal(result.rows[0]?.requests, 2);
});

test("LeaderboardRollupStore persists hourly buckets across reload and prunes old hours", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-leaderboard-"));
  let now = Date.parse("2026-07-27T12:30:00.000Z");
  try {
    const store = new LeaderboardRollupStore({
      home,
      config: {
        liveLimit: 1000,
        liveTtlHours: 24,
        durable: true,
        durableRetentionDays: 1
      },
      now: () => now,
      flushDelayMs: 0
    });
    store.record(
      inspection({
        callId: "old",
        principal: { tokenId: "tok_old", label: "old" },
        cost: 1,
        startedAt: "2026-07-25T10:15:00.000Z"
      })
    );
    store.record(
      inspection({
        callId: "new",
        principal: { tokenId: "tok_new", label: "new" },
        cost: 2,
        startedAt: "2026-07-27T11:15:00.000Z"
      })
    );
    store.flush();
    const raw = JSON.parse(readFileSync(store.path(), "utf8")) as {
      buckets: Array<{ hour: string }>;
    };
    assert.equal(raw.buckets.length, 1);
    assert.equal(raw.buckets[0]?.hour, "2026-07-27T11:00:00.000Z");

    const reloaded = new LeaderboardRollupStore({
      home,
      config: {
        liveLimit: 1000,
        liveTtlHours: 24,
        durable: true,
        durableRetentionDays: 14
      },
      now: () => now,
      flushDelayMs: 0
    });
    const board = reloaded.query({
      by: "principal",
      sort: "cost",
      limit: 10,
      window: "24h"
    });
    assert.equal(board.rows.length, 1);
    assert.equal(board.rows[0]?.key, "tok_new");
    assert.equal(board.rows[0]?.estimateUsd, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LeaderboardRollupStore ignores records while durable is disabled", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-leaderboard-off-"));
  try {
    const store = new LeaderboardRollupStore({
      home,
      config: {
        liveLimit: 1000,
        liveTtlHours: 24,
        durable: false,
        durableRetentionDays: 14
      },
      flushDelayMs: 0
    });
    store.record(
      inspection({
        callId: "x",
        principal: { tokenId: "tok", label: "x" },
        cost: 1
      })
    );
    store.flush();
    assert.equal(
      store.query({
        by: "principal",
        sort: "cost",
        limit: 10,
        window: "24h"
      }).rows.length,
      0
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider leaderboard aggregates completed calls across accounts under one provider", () => {
  // Account identity is not a leaderboard dimension; two accounts under
  // the same provider roll into one provider row from completed calls only.
  const result = aggregateInspections(
    [
      inspection({
        callId: "work-1",
        provider: "codex",
        model: "codex/gpt-5.5",
        cost: 1,
        tokens: 20
      }),
      inspection({
        callId: "personal-1",
        provider: "codex",
        model: "codex/gpt-5.5",
        cost: 2,
        tokens: 30
      }),
      inspection({
        callId: "claude-1",
        provider: "claude-code",
        model: "claude-code/claude-opus",
        cost: 5,
        tokens: 10
      })
    ],
    { by: "provider", sort: "requests", limit: 10 }
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.key, "codex");
  assert.equal(result.rows[0]?.requests, 2);
  assert.equal(result.rows[0]?.tokensTotal, 60);
  assert.equal(result.rows[0]?.estimateUsd, 3);
  assert.equal(result.rows[1]?.key, "claude-code");
  assert.equal(result.rows[1]?.requests, 1);
});

test("account activity persistence stays independent of leaderboard rollups", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-leaderboard-activity-"));
  const usageDirectory = join(home, "usage");
  mkdirSync(usageDirectory, { recursive: true, mode: 0o700 });
  const activityPath = join(usageDirectory, "account-activity.v1.json");
  try {
    const rollups = new LeaderboardRollupStore({
      home,
      config: {
        liveLimit: 1000,
        liveTtlHours: 24,
        durable: false,
        durableRetentionDays: 14
      },
      flushDelayMs: 0
    });
    const activity = new AccountActivityCoordinator({
      statePath: activityPath,
      persistDebounceMs: 0,
      now: () => 1_700_000_000_000
    });

    const before = aggregateInspections(
      [
        inspection({
          callId: "a",
          provider: "codex",
          principal: { tokenId: "tok", label: "alice" },
          cost: 1.5
        })
      ],
      { by: "principal", sort: "cost", limit: 10 }
    );

    const release = activity.beginAttempt("codex:work");
    activity.flush();
    release();
    rollups.record(
      inspection({
        callId: "ignored-while-disabled",
        principal: { tokenId: "tok", label: "alice" },
        cost: 99
      })
    );
    rollups.flush();

    const after = aggregateInspections(
      [
        inspection({
          callId: "a",
          provider: "codex",
          principal: { tokenId: "tok", label: "alice" },
          cost: 1.5
        })
      ],
      { by: "principal", sort: "cost", limit: 10 }
    );
    assert.deepEqual(after, before);
    assert.equal(existsSync(activityPath), true);
    assert.equal(existsSync(rollups.path()), false);
    assert.equal(activity.snapshot("codex:work").lastSelected, true);
    assert.equal(activity.snapshot("codex:work").inFlight, 0);
    assert.equal(
      rollups.query({
        by: "principal",
        sort: "cost",
        limit: 10,
        window: "24h"
      }).rows.length,
      0
    );
    activity.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
