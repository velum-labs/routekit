import assert from "node:assert/strict";
import test from "node:test";

import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { gatewayHealthy } from "../adapters/gateway-probe.js";

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

test("gatewayHealthy accepts successful readiness responses", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(requestUrl(input), "http://gateway.test/health");
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    return new Response("ok", { status: 200 });
  };
  try {
    assert.equal(await runRouteKitEffect(gatewayHealthy("http://gateway.test")), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("gatewayHealthy fails closed on HTTP and transport errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    assert.equal(await runRouteKitEffect(gatewayHealthy("http://gateway.test")), false);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    assert.equal(await runRouteKitEffect(gatewayHealthy("http://gateway.test")), false);
  } finally {
    globalThis.fetch = original;
  }
});
