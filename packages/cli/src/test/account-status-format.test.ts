import assert from "node:assert/strict";
import test from "node:test";

import {
  accountReadyForOverview,
  formatAccountActivityMarkers,
  formatAccountsStatusDetail,
  formatOverviewReadinessSuffix,
  formatUsageReadinessSuffix
} from "../account-status-format.js";
import { renderDaemonOverviewLines } from "../effect/commands/status.js";

test("activity markers use serving and last-selected vocabulary", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(
    formatAccountActivityMarkers(
      {
        serving: true,
        inFlight: 3,
        lastSelected: true,
        lastSelectedAt: now - 5_000
      },
      now
    ),
    " (serving 3) (last selected 5s ago)"
  );
  assert.equal(
    formatAccountActivityMarkers(
      {
        serving: false,
        inFlight: 0,
        lastSelected: false,
        lastSelectedAt: now - 60_000
      },
      now
    ),
    ""
  );
  assert.equal(
    formatAccountActivityMarkers({ serving: false, inFlight: 0, lastSelected: true }, now),
    " (last selected)"
  );
});

test("readiness helpers stay diagnostic and independent from activity", () => {
  assert.equal(formatUsageReadinessSuffix({ coolingUntil: Date.now() / 1000 + 30 }), " · cooling");
  assert.equal(
    formatAccountsStatusDetail({
      credentialValid: true,
      configured: true,
      relayOpen: true,
      localOnly: true
    }),
    "stored; configured; relay ready · local-only"
  );
  assert.equal(
    formatOverviewReadinessSuffix({ configured: false, relayOpen: true }),
    " · routing disabled"
  );
  assert.equal(
    accountReadyForOverview({
      credentialValid: true,
      configured: true,
      relayOpen: false
    }),
    false
  );
});

test("readiness reasons produce distinct diagnostics with field-level defaults", () => {
  const now = Date.UTC(2026, 0, 1);
  const cases = [
    [{ code: "credential_invalid" as const }, "credential invalid"],
    [{ code: "credential_expired" as const, expiresAt: 1 }, "credential expired"],
    [
      { code: "provider_auth_rejected" as const, status: 401 as const },
      "upstream auth rejected (401); re-login required"
    ],
    [{ code: "provider_auth_refreshing" as const }, "upstream auth refreshing"],
    [
      { code: "provider_auth_backoff" as const, until: now / 1000 + 30 },
      "auth refresh retrying in 30s"
    ],
    [{ code: "catalog_empty" as const }, "catalog empty"],
    [{ code: "model_unavailable" as const, model: "gpt-work" }, "model unavailable (gpt-work)"],
    [{ code: "cooldown_active" as const, until: 2 }, "cooling"],
    [
      { code: "provider_quota_rejected" as const, window: "weekly", status: "rejected" },
      "provider rejected (weekly)"
    ],
    [
      { code: "provider_quota_exceeded" as const, window: "five_hour", status: "exceeded" },
      "provider quota exceeded (five_hour)"
    ],
    [
      {
        code: "quota_switch_threshold" as const,
        window: "primary",
        utilization: 0.94,
        switchThreshold: 0.9
      },
      "quota threshold (primary 94%)"
    ]
  ] as const;
  for (const [reason, label] of cases) {
    const account = {
      credentialValid: true,
      configured: true,
      relayOpen: false,
      readinessReasons: [reason]
    };
    assert.equal(formatUsageReadinessSuffix(account, now), ` · ${label}`);
    assert.equal(formatAccountsStatusDetail(account, now), `stored; configured; ${label}`);
    assert.equal(formatOverviewReadinessSuffix(account, now), ` · ${label}`);
  }

  assert.equal(
    accountReadyForOverview({
      credentialValid: true,
      configured: true,
      relayOpen: true,
      readinessReasons: [{ code: "catalog_empty" }]
    }),
    false
  );
  assert.equal(accountReadyForOverview({ poolEligible: false }), false);
  assert.equal(accountReadyForOverview({ relayReady: false }), false);
  assert.equal(accountReadyForOverview({ relayOpen: true }), true);

  assert.equal(formatUsageReadinessSuffix({ poolEligible: false }), " · ineligible");
  assert.equal(
    formatAccountsStatusDetail({ credentialValid: true, configured: true, relayOpen: false }),
    "stored; configured; relay unavailable or cooling"
  );
});

test("top-level status renders shared activity markers", () => {
  const now = Date.UTC(2026, 0, 1);
  const lines = renderDaemonOverviewLines(
    {
      daemon: {
        running: true,
        healthy: true,
        pid: 7,
        packageVersion: "0.14.0",
        dataUrl: "http://127.0.0.1:8080",
        generation: 2,
        configRevision: 4
      },
      providers: [],
      accounts: {
        accounts: [
          {
            subscriptionKind: "claude-code",
            label: "work",
            credentialValid: true,
            configured: true,
            relayOpen: true,
            serving: true,
            inFlight: 1,
            lastSelected: true,
            lastSelectedAt: now - 120_000
          },
          {
            subscriptionKind: "codex",
            label: "spare",
            credentialValid: true,
            configured: false,
            relayOpen: false,
            serving: false,
            inFlight: 0,
            lastSelected: false
          }
        ]
      },
      models: { count: 0 },
      catalog: { models: [] }
    },
    now
  ).join("\n");

  assert.match(lines, /claude-code\/work \(serving 1\) \(last selected 2m ago\)/);
  assert.match(lines, /codex\/spare · routing disabled/);
  assert.doesNotMatch(lines, /\(active\)/);
});

test("accounts status lines reuse the shared activity markers", () => {
  const now = Date.UTC(2026, 0, 1, 0, 3);
  const entry = {
    subscriptionKind: "codex",
    label: "work",
    serving: true,
    inFlight: 2,
    lastSelected: true,
    lastSelectedAt: now - 60_000,
    credentialValid: true,
    configured: true,
    relayOpen: true
  };
  assert.equal(
    `${entry.subscriptionKind}/${entry.label}${formatAccountActivityMarkers(entry, now)}`,
    "codex/work (serving 2) (last selected 1m ago)"
  );
  assert.equal(formatAccountsStatusDetail(entry), "stored; configured; relay ready");
});

test("watch-style successive snapshots move activity markers", () => {
  const now = Date.UTC(2026, 0, 1);
  const first = formatAccountActivityMarkers(
    {
      serving: true,
      inFlight: 1,
      lastSelected: true,
      lastSelectedAt: now - 5_000
    },
    now
  );
  const second = formatAccountActivityMarkers(
    {
      serving: false,
      inFlight: 0,
      lastSelected: true,
      lastSelectedAt: now - 5_000
    },
    now + 10_000
  );
  assert.equal(first, " (serving 1) (last selected 5s ago)");
  assert.equal(second, " (last selected 15s ago)");
  assert.notEqual(first, second);
});
