import assert from "node:assert/strict";
import test from "node:test";

import { CliError } from "@velum-labs/routekit-cli-core";
import type {
  ResetCreditSnapshot,
  SubscriptionMemberStatus,
  SubscriptionUsageResponse
} from "@velum-labs/routekit-accounts";

import {
  chooseCodexMember,
  chooseResetCreditId,
  soonestResetCredit
} from "../commands/usage.js";
import { buildProgram } from "../cli.js";

function member(
  label: string,
  resetCredits?: ResetCreditSnapshot
): SubscriptionMemberStatus {
  return {
    id: label,
    mode: "codex",
    label,
    sourcePath: `/tmp/${label}.json`,
    serving: false,
    inFlight: 0,
    lastSelected: false,
    models: [],
    ...(resetCredits === undefined
      ? {}
      : {
          limits: {
            windows: {},
            resetCredits,
            observedAt: 1_700_000_000,
            source: "usage",
            completeness: "snapshot"
          }
        })
  };
}

function usage(...members: SubscriptionMemberStatus[]): SubscriptionUsageResponse {
  return {
    accountSets: [{
      mode: "codex",
      strategy: "sticky",
      switchThreshold: 0.9,
      members
    }]
  };
}

test("soonestResetCredit picks the earliest expiry deterministically", () => {
  assert.equal(
    soonestResetCredit([
      { id: "b", expiresAt: 200 },
      { id: "a", expiresAt: 100 },
      { id: "c" }
    ])?.id,
    "a"
  );
  assert.equal(
    soonestResetCredit([
      { id: "b" },
      { id: "a" }
    ])?.id,
    "a"
  );
});

test("chooseCodexMember honors label and single eligible shortcuts", async () => {
  const snapshot = usage(
    member("work", {
      observedAt: 1,
      availableCount: 1,
      credits: [{ id: "RateLimitResetCredit_work", status: "available" }]
    }),
    member("personal", {
      observedAt: 1,
      availableCount: 2,
      credits: [{ id: "RateLimitResetCredit_personal", status: "available" }]
    })
  );
  assert.equal((await chooseCodexMember(snapshot, "personal", false)).label, "personal");
  assert.equal(
    (
      await chooseCodexMember(
        usage(
          member("solo", {
            observedAt: 1,
            availableCount: 1,
            credits: [{ id: "RateLimitResetCredit_solo", status: "available" }]
          })
        ),
        undefined,
        false
      )
    ).label,
    "solo"
  );
});

test("chooseCodexMember requires --label when multiple accounts have resets non-interactively", async () => {
  await assert.rejects(
    () =>
      chooseCodexMember(
        usage(
          member("work", {
            observedAt: 1,
            availableCount: 1,
            credits: [{ id: "a", status: "available" }]
          }),
          member("personal", {
            observedAt: 1,
            availableCount: 1,
            credits: [{ id: "b", status: "available" }]
          })
        ),
        undefined,
        false
      ),
    (error: unknown) =>
      error instanceof CliError && /pass --label/.test(error.message)
  );
});

test("chooseResetCreditId supports explicit, automated, and count-only paths", async () => {
  const detailed = member("work", {
    observedAt: 1,
    availableCount: 2,
    credits: [
      { id: "RateLimitResetCredit_late", status: "available", expiresAt: 300 },
      { id: "RateLimitResetCredit_soon", status: "available", expiresAt: 100 }
    ]
  });
  assert.equal(
    await chooseResetCreditId(detailed, "RateLimitResetCredit_late", true),
    "RateLimitResetCredit_late"
  );
  assert.equal(
    await chooseResetCreditId(detailed, undefined, true),
    "RateLimitResetCredit_soon"
  );
  assert.equal(
    await chooseResetCreditId(
      member("work", { observedAt: 1, availableCount: 3 }),
      undefined,
      true
    ),
    undefined
  );
  await assert.rejects(
    () => chooseResetCreditId(member("work"), undefined, true),
    (error: unknown) =>
      error instanceof CliError && /no redeemable rate-limit resets/.test(error.message)
  );
});

test("usage redeem help documents selection flags", () => {
  const usageCommand = buildProgram().commands.find((command) => command.name() === "usage");
  const redeem = usageCommand?.commands.find((command) => command.name() === "redeem");
  assert.ok(redeem);
  assert.match(redeem.description(), /banked Codex rate-limit reset/i);
  const help = redeem.helpInformation();
  assert.match(help, /--label/);
  assert.match(help, /--credit-id/);
  assert.match(help, /--provider/);
});

test("usage redeem requires --yes outside interactive mode before daemon work", async () => {
  await assert.rejects(
    buildProgram().parseAsync([
      "node",
      "routekit",
      "--json",
      "usage",
      "redeem",
      "--provider",
      "codex",
      "--label",
      "work"
    ]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /requires --yes in non-interactive mode/.test(message);
    }
  );
});
