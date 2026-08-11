import assert from "node:assert/strict";
import test from "node:test";

import { IdempotencyStore } from "../idempotency-store.js";

test("idempotency state survives handler replacement and expires by policy", async () => {
  let now = 10;
  const store = new IdempotencyStore({ ttlMs: 5, now: () => now });
  const entry = { fingerprint: "same", promise: Promise.resolve("result") };
  store.set("operation", entry);
  store.complete("operation", entry);
  assert.equal(await store.get("operation")?.promise, "result");
  now = 16;
  assert.equal(store.get("operation"), undefined);
});

test("idempotency eviction is bounded and failed entries can be removed conditionally", () => {
  const store = new IdempotencyStore({ maxEntries: 1 });
  const first = { fingerprint: "one", promise: Promise.resolve(1) };
  const second = { fingerprint: "two", promise: Promise.resolve(2) };
  store.set("first", first);
  store.complete("first", first);
  store.set("second", second);
  store.complete("second", second);
  assert.equal(store.get("first"), undefined);
  assert.equal(store.get("second"), second);
  store.delete("second", first);
  assert.equal(store.get("second"), second);
  store.delete("second", second);
  assert.equal(store.size, 0);
});
