import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  CapacityPool,
  EffectResourceScope,
  EffectVersionedDocumentStore,
  ensureRunOutputDirEffect,
  makeSingleFlight,
  RouteKitFailure,
  registerCleanupEffect,
  runCleanupsEffect,
  runRouteKitEffect,
  superviseSpawnEffect,
  tryAcquireFileLockEffect,
  writeFileAtomicEffect
} from "../effect-api.js";
import { ResourceDisposalTimeoutError } from "../lifecycle/resource-scope.js";

test("EffectResourceScope disposes owned resources LIFO and aggregates failures", async () => {
  const order: string[] = [];
  const scope = new EffectResourceScope();
  await Effect.runPromise(
    scope.defer(() => {
      order.push("first");
    })
  );
  await Effect.runPromise(
    scope.defer(() => {
      order.push("failing");
      throw new RouteKitFailure({ message: "failed" });
    })
  );
  await Effect.runPromise(
    scope.defer(() => {
      order.push("last");
    })
  );

  await assert.rejects(
    runRouteKitEffect(scope.dispose()),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] instanceof Error &&
      error.errors[0].message === "failed"
  );
  assert.deepEqual(order, ["last", "failing", "first"]);
});

test("EffectResourceScope skips borrowed resources and transfers ownership after startup", async () => {
  let ownedCloses = 0;
  let borrowedCloses = 0;
  const startup = new EffectResourceScope();
  const live = new EffectResourceScope();
  await Effect.runPromise(startup.own({ close: () => ownedCloses++ }));
  await Effect.runPromise(startup.borrow({ close: () => borrowedCloses++ }));
  await Effect.runPromise(startup.transferTo(live));
  await runRouteKitEffect(startup.dispose());
  assert.equal(ownedCloses, 0);
  await runRouteKitEffect(live.dispose());
  assert.equal(ownedCloses, 1);
  assert.equal(borrowedCloses, 0);
});

test("EffectResourceScope shutdown budgets still attempt later finalizers", async () => {
  const order: string[] = [];
  const scope = new EffectResourceScope({ shutdownBudgetMs: 10 });
  await Effect.runPromise(
    scope.defer(() => {
      order.push("later");
    })
  );
  await Effect.runPromise(
    scope.deferEffect(
      Effect.sync(() => {
        order.push("hung");
      }).pipe(Effect.andThen(Effect.never))
    )
  );

  await assert.rejects(
    runRouteKitEffect(scope.dispose()),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof ResourceDisposalTimeoutError)
  );
  assert.deepEqual(order, ["hung", "later"]);
});

test("registerCleanupEffect runs LIFO and unregister removes a callback", async () => {
  const order: string[] = [];
  const unregisterB = await Effect.runPromise(
    registerCleanupEffect(
      Effect.sync(() => {
        order.push("b");
      })
    )
  );
  await Effect.runPromise(
    registerCleanupEffect(
      Effect.sync(() => {
        order.push("a");
      })
    )
  );
  await Effect.runPromise(
    registerCleanupEffect(
      Effect.sync(() => {
        order.push("c");
      })
    )
  );
  unregisterB();
  await Effect.runPromise(runCleanupsEffect);
  assert.deepEqual(order, ["c", "a"]);
  await Effect.runPromise(runCleanupsEffect);
  assert.deepEqual(order, ["c", "a"]);
});

test("ensureRunOutputDirEffect writes a gitignore under managed data directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-effect-outdir-"));
  try {
    const dir = join(root, "runs", "job-1");
    await runRouteKitEffect(ensureRunOutputDirEffect(dir, { dataDirectoryNames: ["runs"] }));
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeFileAtomicEffect replaces the target and does not leave sibling temps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-atomic-"));
  try {
    const path = join(directory, "state.json");
    writeFileSync(path, "old");
    await runRouteKitEffect(writeFileAtomicEffect(path, "new\n", { mode: 0o600 }));
    assert.equal(readFileSync(path, "utf8"), "new\n");
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.includes(".tmp")),
      []
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tryAcquireFileLockEffect is exclusive and release is idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-lock-"));
  try {
    const path = join(directory, "lock");
    const first = await runRouteKitEffect(tryAcquireFileLockEffect(path));
    assert.ok(first);
    const second = await runRouteKitEffect(tryAcquireFileLockEffect(path));
    assert.equal(second, undefined);
    await runRouteKitEffect(first.release);
    await runRouteKitEffect(first.release);
    assert.equal(existsSync(path), false);
    const third = await runRouteKitEffect(tryAcquireFileLockEffect(path));
    assert.ok(third);
    await runRouteKitEffect(third.release);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EffectVersionedDocumentStore keeps missing and corrupt reads distinct", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-docs-"));
  try {
    const path = join(directory, "state.json");
    const diagnostics: string[] = [];
    const store = new EffectVersionedDocumentStore<{ version: number; value: string }>({
      path,
      version: 1,
      decode: (value) => value as { version: number; value: string },
      encode: (value) => value,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message)
    });

    assert.deepEqual(await runRouteKitEffect(store.readResult()), { kind: "missing" });

    writeFileSync(path, "{not json");
    const corrupt = await runRouteKitEffect(store.readResult());
    assert.equal(corrupt.kind, "corrupt");
    assert.equal(await runRouteKitEffect(store.read()), undefined);
    assert.ok(diagnostics.length > 0);

    await runRouteKitEffect(store.write({ version: 1, value: "ok" }));
    const valid = await runRouteKitEffect(store.readResult());
    assert.deepEqual(valid, { kind: "valid", value: { version: 1, value: "ok" } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("single-flight runs work once and waiters share the owner result", async () => {
  let runs = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const flight = yield* makeSingleFlight;
      const work = Effect.gen(function* () {
        runs += 1;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(gate);
        return "shared";
      });
      const owner = yield* Effect.forkChild(flight.run("key", work), { startImmediately: true });
      yield* Deferred.await(started);
      const waiter = yield* Effect.forkChild(
        flight.run("key", Effect.die("waiter must not run owner work")),
        { startImmediately: true }
      );
      yield* Deferred.succeed(gate, undefined);
      assert.equal(yield* Fiber.join(owner), "shared");
      assert.equal(yield* Fiber.join(waiter), "shared");
      assert.equal(runs, 1);
      assert.equal(
        yield* flight.run(
          "key",
          Effect.sync(() => {
            runs += 1;
            return "again";
          })
        ),
        "again"
      );
    })
  );
  assert.equal(runs, 2);
});

test("single-flight waiter interruption does not cancel the owner", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const flight = yield* makeSingleFlight;
      const owner = yield* Effect.forkChild(
        flight.run(
          "key",
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return "done";
          })
        ),
        { startImmediately: true }
      );
      yield* Deferred.await(started);
      const waiter = yield* Effect.forkChild(
        flight.run("key", Effect.die("waiter must not run owner work")),
        { startImmediately: true }
      );
      yield* Fiber.interrupt(waiter);
      const waiterExit = yield* Fiber.await(waiter);
      assert.equal(Exit.isFailure(waiterExit), true);
      if (Exit.isFailure(waiterExit)) assert.equal(Cause.hasInterrupts(waiterExit.cause), true);
      yield* Deferred.succeed(gate, undefined);
      assert.equal(yield* Fiber.join(owner), "done");
    })
  );
});

test("TestClock advances Effect.sleep without waiting on the wall clock", async () => {
  const started = Date.now();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.sleep("1 hour").pipe(Effect.as("done"), Effect.forkChild);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Fiber.join(fiber), "done");
    }).pipe(Effect.provide(TestClock.layer()))
  );
  assert.ok(Date.now() - started < 5_000, "test clock must not wait for real time");
});

test("CapacityPool scoped leases release exactly once", async () => {
  const pool = new CapacityPool(
    [
      { id: "a", value: "alpha", capacity: 1 },
      { id: "b", value: "beta", capacity: 1 }
    ],
    { strategy: "round_robin", now: () => 100 }
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* pool.acquireScoped("request");
        const second = yield* pool.acquireScoped("request");
        assert.deepEqual([first.id, second.id], ["a", "b"]);
        first.release();
      })
    )
  );
  assert.deepEqual(pool.list(), [
    { id: "a", value: "alpha", capacity: 1 },
    { id: "b", value: "beta", capacity: 1 }
  ]);
});

test("superviseSpawnEffect resolves the exit code of a clean child", async () => {
  const exit = await runRouteKitEffect(
    superviseSpawnEffect(process.execPath, ["-e", "process.exit(3)"])
  );
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.signal, null);
  assert.equal(exit.timedOut, false);
  assert.equal(exit.aborted, false);
});
