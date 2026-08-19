import assert from "node:assert/strict";
import test from "node:test";

import { buildProgram } from "../cli.js";
import { child, runProgram } from "./effect-cli-test.js";
import { renderLeaderboard } from "../effect/commands/leaderboard.js";

test("leaderboard rejects account dimension and keeps principal/model/provider", async () => {
  const leaderboard = child(buildProgram(), "leaderboard");
  assert.match(leaderboard.description ?? "", /principals, models, or providers/);
  assert.doesNotMatch(leaderboard.description ?? "", /\baccount\b.*dimension/i);

  await assert.rejects(
    runProgram(buildProgram(), ["leaderboard", "--by", "account"]),
    /ShowHelp: Help requested/
  );
});

test("leaderboard provider rendering aggregates without account rows", () => {
  const lines = renderLeaderboard({
    by: "provider",
    sort: "requests",
    window: {
      start: "2026-07-27T00:00:00.000Z",
      end: "2026-07-27T01:00:00.000Z"
    },
    source: "live",
    sampleSize: 3,
    truncated: false,
    budget: {
      liveLimit: 1000,
      liveTtlHours: 24,
      durable: false,
      durableRetentionDays: 14
    },
    rows: [
      {
        rank: 1,
        key: "codex",
        requests: 2,
        tokensIn: 40,
        tokensOut: 20,
        tokensTotal: 60,
        estimateUsd: 3,
        unknownCostCount: 0,
        unknownUsageCount: 0,
        success: 2,
        error: 0,
        latencyMsAvg: 100
      },
      {
        rank: 2,
        key: "claude-code",
        requests: 1,
        tokensIn: 10,
        tokensOut: 5,
        tokensTotal: 15,
        estimateUsd: 5,
        unknownCostCount: 0,
        unknownUsageCount: 0,
        success: 1,
        error: 0,
        latencyMsAvg: 200
      }
    ]
  }).join("\n");

  assert.match(lines, /provider · sorted by requests/);
  assert.match(lines, /codex/);
  assert.match(lines, /claude-code/);
  assert.doesNotMatch(lines, /\baccount\b/i);
  assert.doesNotMatch(lines, /work|personal/);
});
