import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ResourceDisposalTimeoutError, ResourceScope } from "../resource-scope.js";

test("disposes owned resources LIFO, attempts every finalizer, and aggregates failures", async () => {
  const order: string[] = [];
  const scope = new ResourceScope();
  scope.defer(() => {
    order.push("first");
  });
  scope.defer(() => {
    order.push("failing");
    throw new Error("failed");
  });
  scope.defer(() => {
    order.push("last");
  });

  await assert.rejects(
    scope.dispose(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] instanceof Error &&
      error.errors[0].message === "failed"
  );
  assert.deepEqual(order, ["last", "failing", "first"]);
});

test("disposal is idempotent and borrowed resources are never finalized", async () => {
  let ownedCloses = 0;
  let borrowedCloses = 0;
  const scope = new ResourceScope();
  scope.own({ close: () => ownedCloses++ });
  scope.borrow({ close: () => borrowedCloses++ });

  const first = scope.dispose();
  const second = scope.dispose();
  assert.equal(first, second);
  await first;
  assert.equal(ownedCloses, 1);
  assert.equal(borrowedCloses, 0);
});

test("ownership transfers only after successful startup", async () => {
  const order: string[] = [];
  const startup = new ResourceScope();
  const live = new ResourceScope();
  startup.defer(() => {
    order.push("closed");
  });
  startup.transferTo(live);

  await startup.dispose();
  assert.deepEqual(order, []);
  await live.dispose();
  assert.deepEqual(order, ["closed"]);
});

test("shutdown budgets do not prevent later finalizers from being attempted", async () => {
  const order: string[] = [];
  const scope = new ResourceScope({ shutdownBudgetMs: 10 });
  scope.defer(() => {
    order.push("later");
  });
  scope.defer(async () => {
    order.push("hung");
    await new Promise(() => {});
  });

  await assert.rejects(
    scope.dispose(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof ResourceDisposalTimeoutError)
  );
  assert.deepEqual(order, ["hung", "later"]);
  await delay(1);
});
