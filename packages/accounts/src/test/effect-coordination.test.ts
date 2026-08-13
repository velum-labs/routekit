import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, Exit, Fiber } from "effect";
import { AccountActivityCoordinator } from "../activity.js";
import { AccountAuthCoordinator } from "../auth-health.js";
import { RateLimitTracker } from "../rate-limit-tracker.js";

const fingerprintA = `sha256:${"a".repeat(64)}`;
const fingerprintB = `sha256:${"b".repeat(64)}`;

test("Effect activity coordinator releases attempts and persists last selection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-activity-"));
  try {
    const coordinator = await runRouteKitEffect(
      AccountActivityCoordinator.open({
        statePath: join(directory, "account-activity.v1.json"),
        persistDebounceMs: 0,
        now: () => 1_700_000_000_000
      })
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const release = coordinator.beginAttempt("codex:work");
          yield* Effect.addFinalizer(() => Effect.sync(release));
          const snapshot = coordinator.snapshot("codex:work");
          assert.equal(snapshot.serving, true);
          assert.equal(snapshot.inFlight, 1);
          assert.equal(snapshot.lastSelected, true);
        })
      )
    );
    const after = coordinator.snapshot("codex:work");
    assert.equal(after.serving, false);
    assert.equal(after.inFlight, 0);
    assert.equal(after.lastSelected, true);
    await runRouteKitEffect(coordinator.close());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Effect auth recovery waiters share the owner outcome", async () => {
  const coordinator = await runRouteKitEffect(AccountAuthCoordinator.open({ random: () => 0.5 }));
  try {
    const owner = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(owner.role, "owner");
    if (owner.role !== "owner") return;
    const waiter = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(waiter.role, "waiter");
    if (waiter.role !== "waiter") return;

    assert.equal(
      await runRouteKitEffect(coordinator.markRefreshed(owner.claim, fingerprintB)),
      true
    );
    assert.equal(
      await runRouteKitEffect(coordinator.finishProbation(owner.claim, { kind: "accepted" })),
      true
    );
    assert.deepEqual(await waiter.completion, {
      kind: "accepted",
      fingerprint: fingerprintB
    });
  } finally {
    await runRouteKitEffect(coordinator.close());
  }
});

test("Effect auth recovery waiter interruption does not cancel the owner", async () => {
  const coordinator = await runRouteKitEffect(AccountAuthCoordinator.open({ random: () => 0.5 }));
  try {
    const owner = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(owner.role, "owner");
    if (owner.role !== "owner") return;
    const waiter = coordinator.beginRecovery("codex:work", fingerprintA);
    assert.equal(waiter.role, "waiter");
    if (waiter.role !== "waiter") return;

    const waiterExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.promise(() => waiter.completion),
          {
            startImmediately: true
          }
        );
        return yield* Fiber.interrupt(fiber);
      })
    );
    assert.equal(Exit.isSuccess(waiterExit), true);

    assert.equal(
      await runRouteKitEffect(coordinator.markRefreshed(owner.claim, fingerprintB)),
      true
    );
    assert.equal(
      await runRouteKitEffect(coordinator.finishProbation(owner.claim, { kind: "accepted" })),
      true
    );
    assert.equal(coordinator.snapshot("codex:work", fingerprintB).kind, "accepted");
  } finally {
    await runRouteKitEffect(coordinator.close());
  }
});

test("Effect rate-limit tracker shares cooldown state across instances of one file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-ratelimit-"));
  try {
    const path = join(directory, ".state.json");
    const first = await runRouteKitEffect(RateLimitTracker.open(path, "codex"));
    await runRouteKitEffect(first.cool("work", 1_800_000_000_000));
    const second = await runRouteKitEffect(RateLimitTracker.open(path, "codex"));
    assert.equal(second.coolingUntil("work"), 1_800_000_000_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
