import assert from "node:assert/strict";
import test from "node:test";

import {
  accountReadyForOverview,
  formatAccountActivityMarkers,
  formatAccountsStatusDetail,
  formatOverviewReadinessSuffix,
  formatUsageReadinessSuffix
} from "../account-status-format.js";
import { renderDaemonOverviewLines } from "../commands/status.js";

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
  assert.equal(
    formatUsageReadinessSuffix({ coolingUntil: Date.now() / 1000 + 30 }),
    " · cooling"
  );
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
  assert.equal(
    formatAccountsStatusDetail(entry),
    "stored; configured; relay ready"
  );
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
