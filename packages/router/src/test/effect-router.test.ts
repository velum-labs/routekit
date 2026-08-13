import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import { Effect } from "effect";

import { scopedRouter, startRouterEffect } from "../effect-api.js";

async function withDiscoveryServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "gpt-live" }] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
}

test("scoped router construction closes the generation on scope end", async () => {
  await withDiscoveryServer(async (baseUrl) => {
    const url = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* scopedRouter({
            config: parseRouterConfig({
              providers: { openai: {} },
              defaultModel: "openai/gpt-live"
            }),
            host: "127.0.0.1",
            port: 0,
            env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` }
          });
          assert.equal((yield* Effect.promise(() => fetch(`${router.url}/health`))).status, 200);
          return router.url;
        })
      )
    );
    const closed = await fetch(url).catch((error: unknown) => error);
    assert.ok(closed instanceof Error);
  });
});

test("startRouterEffect preserves the Promise RunningRouter façade", async () => {
  const router = await Effect.runPromise(
    startRouterEffect({
      config: parseRouterConfig({ providers: {} }),
      host: "127.0.0.1",
      port: 0,
      env: {}
    })
  );
  try {
    assert.equal((await fetch(`${router.url}/health`)).status, 200);
  } finally {
    await router.close();
  }
});
