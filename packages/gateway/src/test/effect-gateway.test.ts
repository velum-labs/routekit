import assert from "node:assert/strict";
import { test } from "node:test";

import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { type Backend, borrowedBackendPorts } from "../backend.js";
import { scopedGateway } from "../effect-api.js";
import { startGateway } from "../server.js";

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
  const url = await runRouteKitEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* scopedGateway({ backend: emptyBackend() });
        const client = yield* HttpClient.HttpClient;
        const health = yield* client.execute(HttpClientRequest.get(`${gateway.url()}/health`));
        assert.equal(health.status, 200);
        return gateway.url();
      })
    )
  );
  await assert.rejects(fetch(url));
});

test("startGateway serves health until close", async () => {
  const gateway = await startGateway({ backend: emptyBackend() });
  try {
    const client = await runRouteKitEffect(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        return yield* http.execute(HttpClientRequest.get(`${gateway.url()}/health`));
      })
    );
    assert.equal(client.status, 200);
  } finally {
    await gateway.close();
  }
});
