import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRateLimitWindowName,
  formatResetCountdown,
  formatResetCreditHint,
  formatResetCreditTitle,
  formatUtilizationBar,
  limitsSummary,
  renderUsageLines
} from "../usage-format.js";

test("usage formatters clamp bars and show precise reset countdowns", () => {
  assert.match(formatUtilizationBar(0.52), /52%$/);
  assert.match(formatUtilizationBar(2), /100%$/);
  assert.equal(
    formatResetCountdown(Date.UTC(2026, 0, 1, 2, 14) / 1000, Date.UTC(2026, 0, 1)),
    "resets in 2h 14m"
  );
  assert.equal(
    formatResetCountdown(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 0, 1)),
    "resets now"
  );
  assert.equal(formatRateLimitWindowName("five_hour"), "5 hour");
  assert.equal(formatRateLimitWindowName("seven_day_sonnet"), "7 day · sonnet");
  assert.equal(formatRateLimitWindowName("extra_usage"), "extra usage");
});

test("usage rendering shows serving and last-selected markers without active", () => {
  const now = Date.UTC(2026, 0, 1);
  const output = renderUsageLines(
    {
      accountSets: [
        {
          mode: "claude-code",
          strategy: "sticky",
          switchThreshold: 0.9,
          members: [
            {
              id: "one",
              mode: "claude-code",
              label: "work",
              sourcePath: "/private/work.json",
              serving: true,
              inFlight: 2,
              lastSelectedAt: now - 90_000,
              lastSelected: true,
              credentialValid: true,
              poolEligible: true,
              relayReady: true,
              models: [],
              limits: {
                windows: {
                  five_hour: {
                    utilization: 0.1,
                    observedAt: now / 1000 - 10,
                    source: "usage"
                  }
                },
                observedAt: now / 1000 - 10,
                source: "usage",
                completeness: "partial"
              }
            },
            {
              id: "two",
              mode: "claude-code",
              label: "spare",
              sourcePath: "/private/spare.json",
              serving: false,
              inFlight: 0,
              lastSelectedAt: now - 3_600_000,
              lastSelected: false,
              coolingUntil: now / 1000 + 120,
              credentialValid: true,
              poolEligible: false,
              relayReady: false,
              models: []
            }
          ]
        }
      ]
    },
    now
  ).join("\n");

  assert.match(output, /work \(serving 2\) \(last selected 2m ago\)/);
  assert.match(output, /spare · cooling/);
  assert.doesNotMatch(output, /\(active\)/);
  assert.doesNotMatch(output, /spare \(last selected/);
});

test("usage rendering exposes structured readiness diagnostics", () => {
  const base = {
    id: "work",
    mode: "codex" as const,
    sourcePath: "/private/work.json",
    serving: false,
    inFlight: 0,
    lastSelected: false,
    credentialValid: true,
    poolEligible: false,
    relayReady: false,
    models: [] as string[]
  };
  const reasons = [
    { code: "credential_expired" as const, expiresAt: 1 },
    { code: "catalog_empty" as const },
    { code: "model_unavailable" as const, model: "gpt-work" },
    { code: "cooldown_active" as const, until: 2 },
    { code: "provider_quota_rejected" as const, window: "weekly", status: "rejected" },
    { code: "provider_quota_exceeded" as const, window: "daily", status: "exceeded" },
    {
      code: "quota_switch_threshold" as const,
      window: "primary",
      utilization: 0.95,
      switchThreshold: 0.9
    }
  ];
  const output = renderUsageLines({
    accountSets: [
      {
        mode: "codex",
        strategy: "sticky",
        switchThreshold: 0.9,
        members: reasons.map((reason, index) => ({
          ...base,
          id: String(index),
          label: `account-${index}`,
          readinessReasons: [reason]
        }))
      }
    ]
  }).join("\n");
  assert.match(output, /credential expired/);
  assert.match(output, /catalog empty/);
  assert.match(output, /model unavailable \(gpt-work\)/);
  assert.match(output, /cooling/);
  assert.match(output, /provider rejected \(weekly\)/);
  assert.match(output, /provider quota exceeded \(daily\)/);
  assert.match(output, /quota threshold \(primary 95%\)/);
});

test("usage rendering includes windows, provenance, and no-observation hint", () => {
  const now = Date.UTC(2026, 0, 1);
  const usage = {
    accountSets: [
      {
        mode: "codex" as const,
        strategy: "sticky" as const,
        switchThreshold: 0.9,
        members: [
          {
            id: "one",
            mode: "codex" as const,
            label: "work",
            sourcePath: "/private/work.json",
            serving: false,
            inFlight: 0,
            lastSelectedAt: now - 180_000,
            lastSelected: true,
            models: [],
            limits: {
              windows: {
                primary: {
                  utilization: 0.52,
                  resetsAt: now / 1000 + 2 * 60 * 60,
                  observedAt: now / 1000 - 3 * 60,
                  source: "headers" as const
                }
              },
              planType: "pro",
              observedAt: now / 1000 - 3 * 60,
              source: "headers" as const,
              completeness: "partial" as const
            }
          },
          {
            id: "two",
            mode: "codex" as const,
            label: "spare",
            sourcePath: "/private/spare.json",
            serving: false,
            inFlight: 0,
            lastSelected: false,
            models: []
          }
        ]
      }
    ]
  };
  const output = renderUsageLines(usage, now).join("\n");
  assert.match(output, /work \(last selected 3m ago\)/);
  assert.match(output, /primary/);
  assert.match(output, /52%/);
  assert.match(output, /observed 3m ago via headers/);
  assert.match(output, /no usage data available yet/);
  assert.match(output, /routekit doctor/);
  assert.doesNotMatch(output, /\(active\)/);
  assert.equal(limitsSummary(usage, "codex", "work", now), "primary 52% · resets in 2h");
});

test("usage rendering keeps provenance accurate for mixed observations", () => {
  const now = Date.UTC(2026, 0, 1);
  const output = renderUsageLines(
    {
      accountSets: [
        {
          mode: "claude-code",
          strategy: "sticky",
          switchThreshold: 0.9,
          members: [
            {
              id: "work",
              mode: "claude-code",
              label: "work",
              sourcePath: "/private/work.json",
              serving: false,
              inFlight: 0,
              lastSelected: true,
              models: [],
              limits: {
                windows: {
                  five_hour: {
                    utilization: 0.2,
                    observedAt: now / 1000 - 60,
                    source: "usage"
                  },
                  seven_day: {
                    utilization: 0.4,
                    observedAt: now / 1000 - 5,
                    source: "headers"
                  }
                },
                observedAt: now / 1000 - 5,
                source: "headers",
                completeness: "partial"
              }
            }
          ]
        }
      ]
    },
    now
  ).join("\n");

  assert.match(output, /observed/);
  assert.match(output, /1m ago via usage/);
  assert.match(output, /5s ago via headers/);
});

test("usage rendering shows credits-only and exhausted window admission", () => {
  const now = Date.UTC(2026, 0, 1);
  const baseMember = {
    id: "velum",
    mode: "codex" as const,
    label: "velum",
    sourcePath: "/private/velum.json",
    serving: false,
    inFlight: 0,
    lastSelected: true,
    models: [] as string[],
    limits: {
      windows: {
        primary: {
          utilization: 1,
          resetsAt: now / 1000 + 604_800,
          observedAt: now / 1000 - 60,
          source: "usage" as const
        }
      },
      planType: "team",
      observedAt: now / 1000 - 60,
      source: "usage" as const,
      completeness: "snapshot" as const
    }
  };
  const withCredits = renderUsageLines(
    {
      accountSets: [
        {
          mode: "codex",
          strategy: "capacity_weighted",
          switchThreshold: 0.9,
          members: [
            {
              ...baseMember,
              limits: {
                ...baseMember.limits,
                credits: { hasCredits: true, unlimited: false }
              }
            }
          ]
        }
      ]
    },
    now
  ).join("\n");
  const withoutCredits = renderUsageLines(
    {
      accountSets: [
        {
          mode: "codex",
          strategy: "capacity_weighted",
          switchThreshold: 0.9,
          members: [
            {
              ...baseMember,
              limits: {
                ...baseMember.limits,
                credits: { hasCredits: false, unlimited: false }
              }
            }
          ]
        }
      ]
    },
    now
  ).join("\n");
  assert.match(withCredits, /credits-only/);
  assert.match(withoutCredits, /exhausted/);
  assert.doesNotMatch(withCredits, /exhausted/);
});

test("reset credit formatters use human fallbacks and copyable IDs", () => {
  const now = Date.UTC(2026, 0, 1);
  const credit = {
    id: "RateLimitResetCredit_a",
    resetType: "weekly_limit",
    expiresAt: now / 1000 + 7200
  };
  assert.equal(formatResetCreditTitle(credit), "Weekly Limit");
  assert.match(
    formatResetCreditHint(credit, now),
    /weekly_limit · expires in 2h · ID RateLimitResetCredit_a/
  );
  assert.equal(formatResetCreditTitle({ id: "fallback" }), "Rate-limit reset");
});

test("usage rendering shows banked Codex rate-limit resets", () => {
  const now = Date.UTC(2026, 0, 1);
  const output = renderUsageLines(
    {
      accountSets: [
        {
          mode: "codex",
          strategy: "sticky",
          switchThreshold: 0.9,
          members: [
            {
              id: "work",
              mode: "codex",
              label: "work",
              sourcePath: "/private/work.json",
              serving: false,
              inFlight: 0,
              lastSelected: true,
              models: [],
              limits: {
                windows: {
                  primary: {
                    utilization: 1,
                    resetsAt: now / 1000 + 3600,
                    observedAt: now / 1000 - 60,
                    source: "usage"
                  }
                },
                planType: "plus",
                resetCredits: {
                  availableCount: 2,
                  observedAt: now / 1000 - 600,
                  credits: [
                    {
                      id: "RateLimitResetCredit_a",
                      status: "available",
                      resetType: "weekly_limit",
                      title: "Weekly reset",
                      description: "Clears the weekly usage window.",
                      expiresAt: now / 1000 + 12 * 86_400
                    },
                    {
                      id: "RateLimitResetCredit_b",
                      status: "available",
                      expiresAt: now / 1000 + 20 * 86_400
                    }
                  ]
                },
                observedAt: now / 1000 - 60,
                source: "usage",
                completeness: "snapshot"
              }
            }
          ]
        }
      ]
    },
    now
  ).join("\n");
  assert.match(output, /resets\s+2 resets available \(expires in 12d\)/);
  assert.match(output, /Weekly reset · weekly_limit · expires in 12d · ID RateLimitResetCredit_a/);
  assert.match(output, /Clears the weekly usage window/);
  assert.match(output, /reset details stale; observed 10m ago/);
});

test("usage rendering identifies count-only reset snapshots", () => {
  const now = Date.UTC(2026, 0, 1);
  const output = renderUsageLines(
    {
      accountSets: [
        {
          mode: "codex",
          strategy: "sticky",
          switchThreshold: 0.9,
          members: [
            {
              id: "work",
              mode: "codex",
              label: "work",
              sourcePath: "/private/work.json",
              serving: false,
              inFlight: 0,
              lastSelected: false,
              models: [],
              limits: {
                windows: {},
                resetCredits: { availableCount: 3, observedAt: now / 1000 },
                observedAt: now / 1000,
                source: "usage",
                completeness: "snapshot"
              }
            }
          ]
        }
      ]
    },
    now
  ).join("\n");
  assert.match(output, /3 resets available/);
  assert.match(output, /details unavailable \(count only; provider selects on redeem\)/);
});

test("usage watch-style refreshes move serving markers between snapshots", () => {
  const now = Date.UTC(2026, 0, 1);
  const member = {
    id: "one",
    mode: "claude-code" as const,
    label: "work",
    sourcePath: "/private/work.json",
    serving: true,
    inFlight: 2,
    lastSelectedAt: now - 90_000,
    lastSelected: true,
    credentialValid: true,
    poolEligible: true,
    relayReady: true,
    models: [] as string[],
    limits: {
      windows: {},
      observedAt: now / 1000,
      source: "usage" as const,
      completeness: "snapshot" as const
    }
  };
  const first = renderUsageLines(
    {
      accountSets: [
        {
          mode: "claude-code",
          strategy: "sticky",
          switchThreshold: 0.9,
          members: [member]
        }
      ]
    },
    now
  ).join("\n");
  const second = renderUsageLines(
    {
      accountSets: [
        {
          mode: "claude-code",
          strategy: "sticky",
          switchThreshold: 0.9,
          members: [
            {
              ...member,
              serving: false,
              inFlight: 0,
              lastSelectedAt: now - 90_000
            }
          ]
        }
      ]
    },
    now + 30_000
  ).join("\n");
  assert.match(first, /work \(serving 2\) \(last selected 2m ago\)/);
  assert.match(second, /work \(last selected 2m ago\)/);
  assert.doesNotMatch(second, /\(serving/);
  assert.notEqual(first, second);
});

test("usage rendering surfaces rejected provider utilization", () => {
  const output = renderUsageLines({
    accountSets: [
      {
        mode: "codex",
        strategy: "sticky",
        switchThreshold: 0.9,
        members: [
          {
            id: "work",
            mode: "codex",
            label: "work",
            sourcePath: "/private/work.json",
            serving: false,
            inFlight: 0,
            lastSelected: false,
            models: [],
            limits: {
              windows: {},
              diagnostics: [
                {
                  code: "invalid_utilization",
                  window: "codex:primary",
                  field: "used_percent"
                }
              ],
              observedAt: Date.now() / 1000,
              source: "headers",
              completeness: "partial"
            }
          }
        ]
      }
    ]
  }).join("\n");
  assert.match(output, /warning: ignored invalid used_percent for codex:primary/);
  assert.match(output, /no usage data available yet/);
});
