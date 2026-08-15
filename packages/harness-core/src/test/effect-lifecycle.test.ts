import assert from "node:assert/strict";
import { test } from "node:test";

import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import { PendingRequests } from "../approvals.js";
import { scopedSessionRegistry, scopedTurn } from "../effect-api.js";
import {
  SessionResourceRegistry,
  SingleFlightTurnController,
  TurnAlreadyActiveError
} from "../lifecycle.js";

test("scoped turns release the one-live-turn lease on scope close", async () => {
  const controller = new SingleFlightTurnController();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* scopedTurn(controller);
        assert.equal(controller.active, true);
        assert.equal(lease.signal.aborted, false);
      })
    )
  );
  assert.equal(controller.active, false);
});

test("incomplete scoped turns abort the native operation", async () => {
  const controller = new SingleFlightTurnController();
  let aborted = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* scopedTurn(controller);
        lease.signal.addEventListener("abort", () => {
          aborted = true;
        });
      })
    )
  );
  assert.equal(aborted, true);
});

test("a second turn still fails while a scoped lease is live", async () => {
  const controller = new SingleFlightTurnController();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scopedTurn(controller);
        const result = yield* Effect.exit(scopedTurn(controller));
        assert.equal(Exit.isFailure(result), true);
        if (Exit.isFailure(result)) {
          assert.equal(Cause.findErrorOption(result.cause)._tag, "Some");
          const failure = Cause.findErrorOption(result.cause);
          if (failure._tag === "Some") {
            assert.equal(failure.value instanceof TurnAlreadyActiveError, true);
          }
        }
      })
    )
  );
});

test("Effect turn coordination runs one turn at a time", async () => {
  const controller = new SingleFlightTurnController();
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* controller
        .run(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return "first";
          })
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const overlap = yield* Effect.exit(controller.run(() => Effect.succeed("second")));
      assert.equal(Exit.isFailure(overlap), true);
      if (Exit.isFailure(overlap)) {
        const failure = Cause.findErrorOption(overlap.cause);
        assert.equal(failure._tag, "Some");
        if (failure._tag === "Some") {
          assert.equal(failure.value instanceof TurnAlreadyActiveError, true);
        }
      }
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Fiber.join(first), "first");
      assert.equal(yield* controller.run(() => Effect.succeed("second")), "second");
    })
  );
});

test("caller interruption aborts the turn fiber and releases coordination", async () => {
  const controller = new SingleFlightTurnController();
  let finalizers = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const fiber = yield* controller
        .run((signal) =>
          Effect.acquireRelease(Deferred.succeed(started, signal), () =>
            Effect.sync(() => {
              finalizers += 1;
            })
          ).pipe(Effect.andThen(Effect.never))
        )
        .pipe(Effect.forkChild);
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.equal(signal.aborted, true);
      assert.equal(controller.active, false);
      assert.equal(finalizers, 1);
      assert.equal(yield* controller.run(() => Effect.succeed("recovered")), "recovered");
    })
  );
});

test("approval success and rejection use typed Effect Deferred completion", async () => {
  const pending = new PendingRequests();
  const accepted = pending.open({ requestType: "exec_command_approval" });
  const rejected = pending.open({ requestType: "file_change_approval" });
  await Effect.runPromise(
    Effect.gen(function* () {
      assert.equal(yield* pending.resolveEffect(accepted.requestId, "accept"), true);
      assert.equal(yield* accepted.decisionEffect, "accept");
      assert.equal(
        yield* pending.rejectEffect(rejected.requestId, new Error("transport closed")),
        true
      );
      const result = yield* Effect.exit(rejected.decisionEffect);
      assert.equal(Exit.isFailure(result), true);
      if (Exit.isFailure(result)) {
        const failure = Cause.findErrorOption(result.cause);
        assert.equal(failure._tag, "Some");
        if (failure._tag === "Some") {
          assert.equal(failure.value._tag, "ApprovalRequestRejectedError");
          assert.equal(failure.value.requestId, rejected.requestId);
        }
      }
    })
  );
  await assert.rejects(rejected.decision, /transport closed/);
});

test("interrupting one approval waiter preserves shared recovery", async () => {
  const pending = new PendingRequests();
  const request = pending.open({ requestType: "tool_approval" });
  await Effect.runPromise(
    Effect.gen(function* () {
      const interrupted = yield* request.decisionEffect.pipe(Effect.forkChild);
      const survivor = yield* request.decisionEffect.pipe(Effect.forkChild);
      yield* Fiber.interrupt(interrupted);
      assert.equal(yield* pending.resolveEffect(request.requestId, "acceptForSession"), true);
      assert.equal(yield* Fiber.join(survivor), "acceptForSession");
    })
  );
  assert.equal(await request.decision, "acceptForSession");
});

test("early consumer cancellation interrupts shared turn work", async () => {
  const controller = new SingleFlightTurnController();
  let finalizers = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const turn = yield* controller
        .run((signal) =>
          Effect.acquireRelease(Deferred.succeed(started, signal), () =>
            Effect.sync(() => {
              finalizers += 1;
            })
          ).pipe(Effect.andThen(Effect.never))
        )
        .pipe(Effect.forkChild);
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(turn);
      assert.equal(signal.aborted, true);
      assert.equal(controller.active, false);
      assert.equal(finalizers, 1);
    })
  );
});

test("owned session registry finalizer executes exactly once", async () => {
  let stops = 0;
  const registry = new SessionResourceRegistry();
  registry.manage({
    sessionId: "owned",
    sendTurn: async function* () {},
    respondToRequest: async () => {},
    interrupt: async () => {},
    resumeCursor: () => undefined,
    stop: async () => {
      stops += 1;
    }
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owned = yield* scopedSessionRegistry(registry);
        yield* Effect.promise(() => owned.dispose());
      })
    )
  );
  assert.equal(stops, 1);
});
