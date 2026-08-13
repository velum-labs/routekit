import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { type Backend, borrowedBackendPorts } from "../backend.js";
import { scopedGateway, startGatewayEffect } from "../effect-api.js";

function emptyBackend(): Backend {
  return {
    defaultModel: "mock-model",
    ports: borrowedBackendPorts("mock-model"),
    chat: async () => new Response(JSON.stringify({}), { status: 200 }),
    models: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    embeddings: async () => new Response(JSON.stringify({}), { status: 200 })
  };
}

test("scoped gateway closes the listener when the Effect scope ends", async () => {
  const url = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* scopedGateway({ backend: emptyBackend() });
        const health = yield* Effect.promise(() => fetch(`${gateway.url()}/health`));
        assert.equal(health.status, 200);
        return gateway.url();
      })
    )
  );
  await assert.rejects(fetch(url));
});

test("startGatewayEffect preserves the Promise Gateway façade", async () => {
  const gateway = await Effect.runPromise(startGatewayEffect({ backend: emptyBackend() }));
  try {
    assert.equal((await fetch(`${gateway.url()}/health`)).status, 200);
  } finally {
    await gateway.close();
  }
});
