import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Cause, Effect, Exit } from "effect";

import {
  makeRouteKitRuntime,
  RouteKitFailure,
  RouteKitLive,
  routeKitError,
  runRouteKitEffect,
  runRouteKitEffectExit,
  throwRouteKitExit,
  toRouteKitFailure,
  withAbortSignal
} from "../effect-api.js";

test("runRouteKitEffect executes an Effect using the shared Node platform layer", async () => {
  const value = await runRouteKitEffect(Effect.succeed("routekit"));
  assert.equal(value, "routekit");
});

test("runRouteKitEffect preserves original errors at the Promise boundary", async () => {
  const error = new Error("preserve me");
  await assert.rejects(
    runRouteKitEffect(Effect.fail(toRouteKitFailure(error))),
    (cause: unknown) => cause === error
  );
  await assert.rejects(runRouteKitEffect(Effect.die(error)), (cause: unknown) => cause === error);
});

test("RouteKitLive is the process platform layer behind makeRouteKitRuntime", async () => {
  const value = await Effect.runPromise(Effect.succeed("live").pipe(Effect.provide(RouteKitLive)));
  assert.equal(value, "live");
});

test("runRouteKitEffectExit retains the Effect exit at a Promise boundary", async () => {
  const success = await runRouteKitEffectExit(Effect.succeed(42));
  assert.equal(Exit.isSuccess(success), true);
  if (Exit.isSuccess(success)) assert.equal(success.value, 42);

  const failure = await runRouteKitEffectExit(
    Effect.fail(new RouteKitFailure({ message: "boom" }))
  );
  assert.equal(Exit.isFailure(failure), true);
});

test("a managed RouteKit runtime can be disposed after executing work", async () => {
  const runtime = makeRouteKitRuntime();
  assert.equal(await runtime.runPromise(Effect.succeed("ready")), "ready");
  await runtime.dispose();
  await assert.rejects(runtime.runPromise(Effect.succeed("after-dispose")));
});

test("withAbortSignal interrupts a never-ending Effect when the signal aborts", async () => {
  const controller = new AbortController();
  const running = Effect.runPromiseExit(withAbortSignal(Effect.never, controller.signal));
  await delay(10);
  controller.abort();
  const exit = await running;
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) assert.equal(Cause.hasInterrupts(exit.cause), true);
});

test("withAbortSignal immediately interrupts when passed an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const exit = await Effect.runPromiseExit(withAbortSignal(Effect.never, controller.signal));
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) assert.equal(Cause.hasInterrupts(exit.cause), true);
});

test("withAbortSignal leaves Effects unchanged when no signal is provided", async () => {
  assert.equal(await Effect.runPromise(withAbortSignal(Effect.succeed(7))), 7);
});

test("throwRouteKitExit preserves one Error and aggregates multiple failures", () => {
  const error = new Error("preserve me");
  assert.throws(
    () => throwRouteKitExit(Exit.fail(error)),
    (cause: unknown) => cause === error
  );

  const combined = Cause.combine(Cause.fail(new Error("first")), Cause.fail(new Error("second")));
  const exit = Exit.failCause(combined);
  assert.throws(
    () => throwRouteKitExit(exit),
    (cause: unknown) =>
      cause instanceof AggregateError &&
      cause.errors.length === 2 &&
      cause.errors[0] instanceof Error &&
      cause.errors[1] instanceof Error
  );
});

test("runRouteKitEffect reuses a caller-owned runtime", async () => {
  const runtime = makeRouteKitRuntime();
  try {
    assert.equal(await runRouteKitEffect(Effect.succeed("shared"), runtime), "shared");
    assert.equal(await runRouteKitEffect(Effect.succeed("again"), runtime), "again");
  } finally {
    await runtime.dispose();
  }
});

test("runRouteKitEffect without a runtime reuses the process-lifetime runtime", async () => {
  assert.equal(await runRouteKitEffect(Effect.succeed("first")), "first");
  assert.equal(await runRouteKitEffect(Effect.succeed("second")), "second");
});

test("routeKitError preserves Error identity and tags non-Errors", () => {
  const error = new Error("already an Error");
  assert.equal(routeKitError(error), error);
  assert.equal(routeKitError(toRouteKitFailure(error)), error);
  const wrapped = routeKitError("failure");
  assert.equal(wrapped.message, "failure");
  assert.equal(wrapped.name, "RouteKitFailure");
});
