import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AccountActivityCoordinator,
  subscriptionAccountIdentity
} from "../activity.js";

test("coordinator persists last selection without inFlight and restores it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-activity-"));
  const statePath = join(directory, "account-activity.v1.json");
  try {
    const first = new AccountActivityCoordinator({
      statePath,
      persistDebounceMs: 0,
      now: () => 1_700_000_000_000
    });
    const release = first.beginAttempt(subscriptionAccountIdentity("codex", "work"));
    assert.deepEqual(first.snapshot(subscriptionAccountIdentity("codex", "work")), {
      serving: true,
      inFlight: 1,
      lastSelectedAt: 1_700_000_000_000,
      lastSelected: true
    });
    first.flush();
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      accounts: Array<{ identity: string; lastSelectedAt: number; sequence: number }>;
    };
    assert.deepEqual(persisted.accounts, [
      {
        identity: "codex:work",
        lastSelectedAt: 1_700_000_000_000,
        sequence: 1
      }
    ]);
    release();
    first.close();

    const restored = new AccountActivityCoordinator({ statePath });
    assert.deepEqual(restored.snapshot(subscriptionAccountIdentity("codex", "work")), {
      serving: false,
      inFlight: 0,
      lastSelectedAt: 1_700_000_000_000,
      lastSelected: true
    });
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator breaks lastSelected ties with a monotonic sequence", () => {
  let now = 100;
  const coordinator = new AccountActivityCoordinator({ now: () => now });
  const releaseA = coordinator.beginAttempt("codex:a");
  const releaseB = coordinator.beginAttempt("codex:b");
  assert.equal(coordinator.snapshot("codex:a").lastSelected, false);
  assert.equal(coordinator.snapshot("codex:b").lastSelected, true);
  now = 100;
  const releaseC = coordinator.beginAttempt("codex:a");
  assert.equal(coordinator.snapshot("codex:a").lastSelected, true);
  assert.equal(coordinator.snapshot("codex:b").lastSelected, false);
  releaseA();
  releaseB();
  releaseC();
  assert.equal(coordinator.snapshot("codex:a").inFlight, 0);
  assert.equal(coordinator.snapshot("codex:a").serving, false);
  coordinator.close();
});

test("rename migrates durable selection and remove deletes it", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-activity-rename-"));
  const statePath = join(directory, "account-activity.v1.json");
  try {
    const coordinator = new AccountActivityCoordinator({
      statePath,
      persistDebounceMs: 0,
      now: () => 42
    });
    const release = coordinator.beginAttempt("codex:work");
    release();
    coordinator.rename("codex:work", "codex:personal");
    assert.equal(coordinator.snapshot("codex:work").lastSelectedAt, undefined);
    assert.equal(coordinator.snapshot("codex:personal").lastSelectedAt, 42);
    assert.equal(coordinator.snapshot("codex:personal").lastSelected, true);
    coordinator.remove("codex:personal");
    assert.equal(coordinator.snapshot("codex:personal").lastSelectedAt, undefined);
    coordinator.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reload restores durable identities while preserving live inFlight", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-activity-reload-"));
  const statePath = join(directory, "account-activity.v1.json");
  try {
    const coordinator = new AccountActivityCoordinator({
      statePath,
      persistDebounceMs: 0,
      now: () => 10
    });
    const release = coordinator.beginAttempt("codex:work");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        sequence: 1,
        accounts: [
          { identity: "codex:work", lastSelectedAt: 10, sequence: 1 }
        ]
      })}\n`
    );
    coordinator.reload();
    assert.equal(coordinator.snapshot("codex:work").lastSelectedAt, 10);
    assert.equal(coordinator.snapshot("codex:work").inFlight, 1);
    release();
    assert.equal(coordinator.snapshot("codex:work").inFlight, 0);
    coordinator.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
