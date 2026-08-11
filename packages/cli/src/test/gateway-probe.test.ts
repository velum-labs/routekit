import assert from "node:assert/strict";
import test from "node:test";

import { gatewayHealthy } from "../gateway-probe.js";

test("gatewayHealthy accepts successful readiness responses", async () => {
  assert.equal(
    await gatewayHealthy("http://gateway.test", {
      fetch: async (input, init) => {
        assert.equal(input, "http://gateway.test/health");
        assert.equal(init?.headers && (init.headers as Record<string, string>).accept, "application/json");
        return new Response("ok", { status: 200 });
      }
    }),
    true
  );
});

test("gatewayHealthy fails closed on HTTP and transport errors", async () => {
  assert.equal(
    await gatewayHealthy("http://gateway.test", {
      fetch: async () => new Response("unavailable", { status: 503 })
    }),
    false
  );
  assert.equal(
    await gatewayHealthy("http://gateway.test", {
      fetch: async () => {
        throw new Error("offline");
      }
    }),
    false
  );
});
