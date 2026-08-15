import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import type { RoutingPolicyReader } from "@velum-labs/routekit-gateway";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { startRouter } from "../index.js";

const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
const ROUTEKIT_ROUTING_PROFILE_HEADER = "x-routekit-profile";

async function withDiscoveryServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      if (request.headers.authorization !== "Bearer test") {
        response.statusCode = 401;
        response.end();
        return;
      }
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

async function withRoutingServer(
  run: (baseUrl: string, requestedModels: string[]) => Promise<void>
): Promise<void> {
  const requestedModels: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: [{ id: "preferred" }, { id: "fallback" }, { id: "explicit" }]
          })
        );
        return;
      }
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model?: string;
        };
        if (body.model !== undefined) requestedModels.push(body.model);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [], model: body.model }));
        return;
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, requestedModels);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
}

const config = parseRouterConfig({
  providers: { openai: {} },
  defaultModel: "openai/gpt-live"
});

test("SDK starts only after live provider discovery", async () => {
  await withDiscoveryServer(async (baseUrl) => {
    const running = await startRouter({
      config,
      host: "127.0.0.1",
      port: 0,
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` }
    });
    try {
      const response = await fetch(`${running.url}/v1/models`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      assert.deepEqual(
        body.data.map((model) => model.id),
        ["openai/gpt-live"]
      );
      const usageResponse = await fetch(`${running.url}/usage`);
      assert.equal(usageResponse.status, 200);
      assert.deepEqual(await usageResponse.json(), { accountSets: [] });
    } finally {
      await runRouteKitEffect(running.close);
    }
  });
});

test("model auto resolves a profile winner, falls back, and preserves explicit models", async () => {
  await withRoutingServer(async (baseUrl, requestedModels) => {
    const profile = {
      selectedModel: "openai/not-discovered",
      fallbackModels: ["openai/fallback", "openai/preferred"],
      objective: "lowest-cost" as const,
      suiteDigest: "suite",
      evidenceDigest: "evidence",
      publishedAt: "2026-08-15T00:00:00.000Z"
    };
    const policyReader: RoutingPolicyReader = {
      getProfile: (profileId) =>
        Effect.succeed(profileId === "support" ? profile : undefined)
    };
    const running = await startRouter({
      config: parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "openai/preferred"
      }),
      host: "127.0.0.1",
      port: 0,
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` },
      policyReader
    });
    try {
      const auto = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [ROUTEKIT_ROUTING_PROFILE_HEADER]: "support"
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(auto.status, 200);
      assert.equal(requestedModels.at(-1), "fallback");

      const explicit = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [ROUTEKIT_ROUTING_PROFILE_HEADER]: "missing"
        },
        body: JSON.stringify({
          model: "openai/explicit",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(explicit.status, 200);
      assert.equal(requestedModels.at(-1), "explicit");
    } finally {
      await runRouteKitEffect(running.close);
    }
  });
});

test("model auto rejects missing and unknown profiles and eval bypass traffic", async () => {
  await withRoutingServer(async (baseUrl) => {
    const running = await startRouter({
      config: parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "openai/preferred"
      }),
      host: "127.0.0.1",
      port: 0,
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` },
      policyReader: { getProfile: () => Effect.succeed(undefined) }
    });
    try {
      const missing = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(missing.status, 400);
      assert.match(await missing.text(), /x-routekit-profile/);

      const unknown = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [ROUTEKIT_ROUTING_PROFILE_HEADER]: "missing"
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(unknown.status, 400);
      assert.match(await unknown.text(), /unknown routing profile/);

      const bypass = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [ROUTEKIT_ROUTING_PROFILE_HEADER]: "support",
          [EVAL_POLICY_BYPASS_HEADER]: "1"
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(bypass.status, 400);
      assert.match(await bypass.text(), /explicit provider\/model/);
    } finally {
      await runRouteKitEffect(running.close);
    }
  });
});

test("SDK serves an empty catalog when no providers are configured", async () => {
  const running = await startRouter({
    config: parseRouterConfig({ providers: {} }),
    host: "127.0.0.1",
    port: 0,
    env: {}
  });
  try {
    assert.equal((await fetch(`${running.url}/health`)).status, 200);
    const modelsResponse = await fetch(`${running.url}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    const models = (await modelsResponse.json()) as {
      data: unknown[];
      models: unknown[];
    };
    assert.deepEqual(models.data, []);
    assert.deepEqual(models.models, []);
    assert.deepEqual(await runRouteKitEffect(running.providerStatuses()), []);

    const unavailable = await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /no model is available/);

    const anthropicUnavailable = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(anthropicUnavailable.status, 503);
    assert.deepEqual(await anthropicUnavailable.json(), {
      type: "error",
      error: {
        type: "unavailable",
        message: "no model is available; configure a provider"
      }
    });

    const responsesUnavailable = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" })
    });
    assert.equal(responsesUnavailable.status, 503);
    assert.deepEqual(await responsesUnavailable.json(), {
      error: {
        type: "unavailable",
        message: "no model is available; configure a provider"
      }
    });

    const responsesUnknown = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/not-configured", input: "hello" })
    });
    assert.equal(responsesUnknown.status, 400);
    assert.deepEqual(await responsesUnknown.json(), {
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        param: "model",
        message: "unknown model: openai/not-configured"
      }
    });

    const anthropicUnknown = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/not-configured",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(anthropicUnknown.status, 400);
    assert.deepEqual(await anthropicUnknown.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "unknown model: anthropic/not-configured"
      }
    });

    const countTokensUnknown = await fetch(`${running.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/not-configured",
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(countTokensUnknown.status, 400);
    assert.deepEqual(await countTokensUnknown.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "unknown model: anthropic/not-configured"
      }
    });

    const unknown = await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/not-configured",
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown model/);
  } finally {
    await runRouteKitEffect(running.close);
  }
});

test("SDK requires authentication for non-loopback router binds", async () => {
  await assert.rejects(
    startRouter({ config, host: "0.0.0.0", port: 0 }),
    /binding to non-loopback host "0\.0\.0\.0" requires an auth token/
  );

  await withDiscoveryServer(async (baseUrl) => {
    const authenticated = await startRouter({
      config,
      host: "0.0.0.0",
      port: 0,
      authToken: "secret",
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${baseUrl}/v1` }
    });
    try {
      assert.equal((await fetch(`${authenticated.url}/usage`)).status, 401);
      const usageResponse = await fetch(`${authenticated.url}/usage`, {
        headers: { authorization: "Bearer secret" }
      });
      assert.equal(usageResponse.status, 200);
      assert.deepEqual(await usageResponse.json(), { accountSets: [] });
    } finally {
      await runRouteKitEffect(authenticated.close);
    }
  });
});
