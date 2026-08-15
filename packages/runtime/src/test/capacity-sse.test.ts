import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { gatewayOpenAiBaseUrl, gatewayOrigin, gatewayPath } from "../gateway-url.js";
import { CapacityPool, SseDecoder, SseParseError } from "../index.js";

test("capacity pool exposes opaque members and exact-once lease release", () => {
  const pool = new CapacityPool(
    [
      { id: "a", value: "alpha", capacity: 1 },
      { id: "b", value: "beta", capacity: 1 }
    ],
    { strategy: "round_robin", now: () => 100 }
  );
  const first = Effect.runSync(pool.acquire("request"));
  const second = Effect.runSync(pool.acquire("request"));
  assert.deepEqual([first.id, second.id], ["a", "b"]);
  first.release();
  first.release();
  assert.deepEqual(pool.list(), [
    { id: "a", value: "alpha", capacity: 1 },
    { id: "b", value: "beta", capacity: 1 }
  ]);
});

test("SSE decoder handles split UTF-8 and rejects trailing partial events", () => {
  const decoder = new SseDecoder();
  const encoded = new TextEncoder().encode("event: message\ndata: café\nid: 7\n\n");
  const events = [
    ...decoder.feed(encoded.slice(0, encoded.length - 2)),
    ...decoder.feed(encoded.slice(encoded.length - 2))
  ];
  assert.deepEqual(events, [{ event: "message", data: "café", id: "7" }]);
  assert.deepEqual(decoder.flush(), []);

  const partial = new SseDecoder();
  partial.feed("data: incomplete\n");
  assert.throws(
    () => partial.flush(),
    (error: unknown) => error instanceof SseParseError
  );
});

test("gateway URL helpers normalize origins, OpenAI bases, and paths consistently", () => {
  assert.equal(gatewayOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(gatewayOrigin("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(gatewayOrigin("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080");
  assert.equal(gatewayOpenAiBaseUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1");
  assert.equal(
    gatewayPath("http://127.0.0.1:8080/v1/", "v1/models"),
    "http://127.0.0.1:8080/v1/models"
  );
});
