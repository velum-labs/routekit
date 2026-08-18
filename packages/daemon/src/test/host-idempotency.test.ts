import assert from "node:assert/strict";
import test from "node:test";

import { ControlError } from "@velum-labs/routekit-runtime/control";

import { HostIdempotencyCoordinator } from "../host-idempotency.js";

test("host idempotency retains successful mutations across worker lifetimes", async () => {
  const store = new HostIdempotencyCoordinator();
  const started = await store.begin("config.update", "request-1", "fingerprint");
  assert.equal(started.state, "started");
  if (started.state !== "started") return;
  store.complete(started.operationId, { revision: 2 });

  assert.deepEqual(await store.begin("config.update", "request-1", "fingerprint"), {
    state: "completed",
    result: { revision: 2 }
  });
});

test("host idempotency rejects collisions and joins concurrent duplicate execution", async () => {
  const store = new HostIdempotencyCoordinator();
  const started = await store.begin("accounts.sync", "request-1", "fingerprint");
  assert.equal(started.state, "started");
  if (started.state !== "started") return;

  await assert.rejects(
    store.begin("accounts.sync", "request-1", "different"),
    (error: unknown) => error instanceof ControlError && error.code === "conflict"
  );
  const replay = store.begin("accounts.sync", "request-1", "fingerprint");
  store.complete(started.operationId, { synced: true });
  assert.deepEqual(await replay, { state: "completed", result: { synced: true } });
});

test("failed operations are released for an explicit retry", async () => {
  const store = new HostIdempotencyCoordinator();
  const started = await store.begin("accounts.sync", "request-1", "fingerprint");
  assert.equal(started.state, "started");
  if (started.state !== "started") return;
  const replay = store.begin("accounts.sync", "request-1", "fingerprint");
  store.fail(started.operationId);
  await assert.rejects(replay, /daemon worker operation failed/);

  assert.equal((await store.begin("accounts.sync", "request-1", "fingerprint")).state, "started");
});

test("worker exit releases all in-flight operations owned by that worker", async () => {
  const store = new HostIdempotencyCoordinator();
  const first = await store.begin("accounts.sync", "request-1", "one", 7);
  const second = await store.begin("config.update", "request-2", "two", 7);
  assert.equal(first.state, "started");
  assert.equal(second.state, "started");
  if (first.state !== "started" || second.state !== "started") return;
  const firstReplay = store.begin("accounts.sync", "request-1", "one");
  const secondReplay = store.begin("config.update", "request-2", "two");

  store.failOwner(7);

  await assert.rejects(firstReplay, /daemon worker operation failed/);
  await assert.rejects(secondReplay, /daemon worker operation failed/);
  assert.equal((await store.begin("accounts.sync", "request-1", "one", 8)).state, "started");
  assert.equal((await store.begin("config.update", "request-2", "two", 8)).state, "started");
});
