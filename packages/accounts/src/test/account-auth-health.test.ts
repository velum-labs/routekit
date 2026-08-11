import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountAuthCoordinator } from "../auth-health.js";

const fingerprintA = `sha256:${"a".repeat(64)}`;
const fingerprintB = `sha256:${"b".repeat(64)}`;

function fixture(): { coordinator: AccountAuthCoordinator; root: string; statePath: string } {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-auth-"));
  const statePath = join(root, "subscriptions", "account-auth.v1.json");
  return {
    coordinator: new AccountAuthCoordinator({ statePath, random: () => 0.5 }),
    root,
    statePath
  };
}

test("registers an initial fingerprint as unknown and records accepted evidence", () => {
  const { coordinator, root } = fixture();
  try {
    assert.deepEqual(coordinator.register("codex:work", fingerprintA), {
      kind: "unknown",
      fingerprint: fingerprintA
    });
    assert.equal(coordinator.markAccepted("codex:work", fingerprintA), true);
    assert.equal(coordinator.snapshot("codex:work", fingerprintA).kind, "accepted");
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("coalesces recovery and reserves one probation attempt", async () => {
  const { coordinator, root } = fixture();
  try {
    coordinator.register("codex:work", fingerprintA);
    const owner = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(owner.role, "owner");
    if (owner.role !== "owner") return;
    const waiter = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(waiter.role, "waiter");
    if (waiter.role !== "waiter") return;

    assert.equal(coordinator.markRefreshed(owner.claim, fingerprintB), true);
    assert.equal(coordinator.snapshot("codex:work", fingerprintB).kind, "refreshing");
    assert.equal(coordinator.finishProbation(owner.claim, { kind: "accepted" }), true);
    assert.deepEqual(await waiter.completion, {
      kind: "accepted",
      fingerprint: fingerprintB
    });
    assert.equal(coordinator.finishProbation(owner.claim, { kind: "accepted" }), false);
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale claims cannot mutate a replacement fingerprint", () => {
  const { coordinator, root } = fixture();
  try {
    coordinator.register("codex:work", fingerprintA);
    const recovery = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(recovery.role, "owner");
    if (recovery.role !== "owner") return;

    coordinator.activateFingerprint("codex:work", fingerprintB);
    assert.equal(
      coordinator.failRefresh(recovery.claim, {
        kind: "permanent",
        status: 401,
        reasonCode: "invalid_token"
      }),
      false
    );
    assert.equal(coordinator.snapshot("codex:work", fingerprintB).kind, "unknown");
    assert.deepEqual(coordinator.snapshot("codex:work", fingerprintA), {
      kind: "superseded",
      currentFingerprint: fingerprintB
    });
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("in-flight success cannot cancel recovery and removal settles waiters", async () => {
  const { coordinator, root } = fixture();
  try {
    coordinator.register("codex:work", fingerprintA);
    const owner = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(owner.role, "owner");
    if (owner.role !== "owner") return;
    const waiter = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(waiter.role, "waiter");
    if (waiter.role !== "waiter") return;

    assert.equal(coordinator.markAccepted("codex:work", fingerprintA), false);
    assert.equal(coordinator.snapshot("codex:work", fingerprintA).kind, "refreshing");
    coordinator.remove("codex:work");
    assert.deepEqual(await waiter.completion, {
      kind: "unknown",
      fingerprint: fingerprintA
    });
    assert.equal(
      coordinator.failRefresh(owner.claim, {
        kind: "permanent",
        reasonCode: "invalid_token"
      }),
      false
    );
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists permanent rejection without secret material", () => {
  const { coordinator, root, statePath } = fixture();
  try {
    coordinator.register("codex:work", fingerprintA);
    const recovery = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(recovery.role, "owner");
    if (recovery.role !== "owner") return;
    coordinator.failRefresh(recovery.claim, {
      kind: "permanent",
      status: 401,
      reasonCode: "invalid_grant"
    });

    const text = readFileSync(statePath, "utf8");
    assert.match(text, /"state": "rejected"/);
    assert.doesNotMatch(text, /access_token|refresh_token|provider message/i);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "subscriptions")).mode & 0o777, 0o700);

    const reconstructed = new AccountAuthCoordinator({ statePath });
    assert.equal(reconstructed.register("codex:work", fingerprintA).kind, "rejected");
    reconstructed.close();
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists retryable backoff and retries once its deadline expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-auth-backoff-"));
  const statePath = join(root, "subscriptions", "account-auth.v1.json");
  let now = 1_000;
  const coordinator = new AccountAuthCoordinator({
    statePath,
    now: () => now,
    random: () => 0.5
  });
  try {
    coordinator.register("codex:work", fingerprintA);
    const recovery = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(recovery.role, "owner");
    if (recovery.role !== "owner") return;
    coordinator.failRefresh(recovery.claim, {
      kind: "transient",
      failureKind: "network"
    });
    const blocked = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(blocked.role, "blocked");
    if (blocked.role !== "blocked") return;
    assert.equal(blocked.snapshot.retryAt, 6_000);
    assert.equal(blocked.snapshot.attempts, 1);

    now = 6_000;
    assert.equal(coordinator.beginRecovery("codex:work", fingerprintA).role, "owner");
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename, remove, reconcile, reload, and malformed entries are safe", () => {
  const { coordinator, root, statePath } = fixture();
  try {
    coordinator.register("codex:old", fingerprintA);
    coordinator.rename("codex:old", "codex:new");
    assert.equal(coordinator.snapshot("codex:new", fingerprintA).kind, "unknown");
    coordinator.reconcileActiveCredentials(new Map([["codex:new", fingerprintB]]));
    assert.equal(coordinator.snapshot("codex:new", fingerprintB).kind, "unknown");
    coordinator.remove("codex:new");

    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        accounts: [
          null,
          { identity: 42 },
          {
            identity: "codex:bad",
            fingerprint: fingerprintA,
            state: "rejected",
            status: 500
          }
        ]
      })
    );
    coordinator.reload();
    assert.equal(coordinator.register("codex:bad", fingerprintA).kind, "unknown");
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt auth state emits a diagnostic before credentials revalidate", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-auth-corrupt-"));
  const statePath = join(root, "account-auth.v1.json");
  const diagnostics: string[] = [];
  writeFileSync(statePath, JSON.stringify({ version: 1, accounts: [null] }));
  const coordinator = new AccountAuthCoordinator({
    statePath,
    onDiagnostic: ({ message }) => diagnostics.push(message)
  });
  try {
    assert.equal(coordinator.register("codex:work", fingerprintA).kind, "unknown");
    assert.deepEqual(diagnostics, ["auth account entry must be an object"]);
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});
