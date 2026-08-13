import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect, Exit, Fiber } from "effect";

import {
  EffectAccountActivityCoordinator,
  EffectAccountAuthCoordinator,
  EffectRateLimitTracker
} from "../effect-api.js";

const fingerprintA = `sha256:${"a".repeat(64)}`;
const fingerprintB = `sha256:${"b".repeat(64)}`;

test("Effect activity coordinator releases attempts and persists last selection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-activity-"));
  try {
    const coordinator = new EffectAccountActivityCoordinator({
      statePath: join(directory, "account-activity.v1.json"),
      persistDebounceMs: 0,
      now: () => 1_700_000_000_000
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* coordinator.attempt("codex:work");
          const snapshot = yield* coordinator.snapshot("codex:work");
          assert.equal(snapshot.serving, true);
          assert.equal(snapshot.inFlight, 1);
          assert.equal(snapshot.lastSelected, true);
        })
      )
    );
    const after = await Effect.runPromise(coordinator.snapshot("codex:work"));
    assert.equal(after.serving, false);
    assert.equal(after.inFlight, 0);
    assert.equal(after.lastSelected, true);
    await Effect.runPromise(coordinator.close());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Effect auth recovery waiters share the owner outcome", async () => {
  const coordinator = new EffectAccountAuthCoordinator({ random: () => 0.5 });
  try {
    const owner = await Effect.runPromise(coordinator.beginRecovery("codex:work", fingerprintA));
    assert.equal(owner.role, "owner");
    if (owner.role !== "owner") return;
    const waiter = await Effect.runPromise(coordinator.beginRecovery("codex:work", fingerprintA));
    assert.equal(waiter.role, "waiter");
    if (waiter.role !== "waiter") return;

    assert.equal(coordinator.inner.markRefreshed(owner.claim, fingerprintB), true);
    assert.equal(coordinator.inner.finishProbation(owner.claim, { kind: "accepted" }), true);
    assert.deepEqual(await Effect.runPromise(waiter.completion), {
      kind: "accepted",
      fingerprint: fingerprintB
    });
  } finally {
    await Effect.runPromise(coordinator.close());
  }
});

test("Effect auth recovery waiter interruption does not cancel the owner", async () => {
  const coordinator = new EffectAccountAuthCoordinator({ random: () => 0.5 });
  try {
    const owner = await Effect.runPromise(coordinator.beginRecovery("codex:work", fingerprintA));
    assert.equal(owner.role, "owner");
    if (owner.role !== "owner") return;
    const waiter = await Effect.runPromise(coordinator.beginRecovery("codex:work", fingerprintA));
    assert.equal(waiter.role, "waiter");
    if (waiter.role !== "waiter") return;

    const waiterExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(waiter.completion, { startImmediately: true });
        return yield* Fiber.interrupt(fiber);
      })
    );
    assert.equal(Exit.isSuccess(waiterExit), true);

    assert.equal(coordinator.inner.markRefreshed(owner.claim, fingerprintB), true);
    assert.equal(coordinator.inner.finishProbation(owner.claim, { kind: "accepted" }), true);
    assert.equal(coordinator.inner.snapshot("codex:work", fingerprintB).kind, "accepted");
  } finally {
    await Effect.runPromise(coordinator.close());
  }
});

test("Effect rate-limit tracker shares cooldown state across instances of one file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-ratelimit-"));
  try {
    const path = join(directory, ".state.json");
    const first = new EffectRateLimitTracker(path, "codex");
    await Effect.runPromise(first.cool("work", 1_800_000_000_000));
    const second = new EffectRateLimitTracker(path, "codex");
    assert.equal(await Effect.runPromise(second.coolingUntil("work")), 1_800_000_000_000);
    assert.equal(await Effect.runPromise(second.clearCooling("work")), true);
    assert.equal(await Effect.runPromise(first.coolingUntil("work")), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
