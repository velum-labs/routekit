import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderFailureError } from "@velum-labs/routekit-contracts";
import { Effect } from "effect";

import { type Backend, borrowedBackendPorts } from "../backend.js";
import { startGateway } from "../server.js";
import { startSwitchingGatewayProxy } from "../switching-proxy.js";

/**
 * Crash resilience: an upstream stream that dies mid-response (the shape of a
 * local model server being OOM-killed during a turn) must fail only that one
 * request. Historically the error path wrote JSON onto a response whose
 * headers were already sent, which threw inside the catch handler and killed
 * the whole process hosting the gateway, leaving the client with a bare
 * "stream disconnected" error.
 */

/** A backend whose chat stream emits one SSE chunk, then errors mid-stream. */
function midStreamFailureBackend(): Backend {
  return {
    defaultModel: "mock-model",
    ports: borrowedBackendPorts("mock-model"),
    chat: () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "utf8")
          );
          controller.error(new Error("upstream server crashed (simulated OOM kill)"));
        }
      });
      return Effect.succeed(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      );
    },
    models: () =>
      Effect.succeed(
        new Response(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      ),
    embeddings: () => Effect.succeed(new Response(JSON.stringify({}), { status: 200 }))
  };
}

test("a mid-stream upstream failure does not kill the gateway process", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const gateway = await startGateway({ backend: midStreamFailureBackend() });
  try {
    // The streaming request fails abnormally (destroyed socket), not silently.
    await assert.rejects(async () => {
      const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock-model",
          stream: true,
          messages: [{ role: "user", content: "hi" }]
        })
      });
      await response.text();
    });

    // Give any would-be unhandled rejection a macrotask to surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, [], "no unhandled rejection escaped the error path");

    // The gateway (and its hosting process) is still alive and serving.
    const health = await fetch(`${gateway.url()}/health`);
    assert.equal(health.status, 200);
    const models = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(models.status, 200);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await Effect.runPromise(gateway.close);
  }
});

test("an error before headers are sent still yields a 502 JSON body", async () => {
  const backend: Backend = {
    ...midStreamFailureBackend(),
    chat: () => {
      throw new Error("backend exploded before responding");
    }
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error?: { message?: string; type?: string } };
    assert.equal(body.error?.type, "upstream_error");
    assert.equal(body.error?.message, "upstream request failed");
  } finally {
    await Effect.runPromise(gateway.close);
  }
});

test("provider failure categories map exhaustively to gateway status and error type", async () => {
  const cases = [
    ["quota_exhausted", 429, "rate_limit_error"],
    ["auth_permanent", 502, "provider_auth_error"],
    ["auth_transient", 503, "provider_auth_recovery_error"],
    ["transient", 503, "upstream_error"],
    ["context_overflow", 400, "context_length_exceeded"],
    ["unknown", 502, "upstream_error"]
  ] as const;
  for (const [category, status, type] of cases) {
    const backend: Backend = {
      ...midStreamFailureBackend(),
      chat: () => {
        throw new ProviderFailureError({
          category,
          message: `${category} failure`,
          ...(category === "quota_exhausted" || category === "auth_transient"
            ? { retryAfter: 17 }
            : {})
        });
      }
    };
    const gateway = await startGateway({ backend });
    try {
      const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock-model",
          messages: [{ role: "user", content: "hi" }]
        })
      });
      assert.equal(response.status, status);
      assert.equal(((await response.json()) as { error: { type: string } }).error.type, type);
      assert.equal(
        response.headers.get("retry-after"),
        category === "quota_exhausted" || category === "auth_transient" ? "17" : null
      );
    } finally {
      await Effect.runPromise(gateway.close);
    }
  }
});

test("client disconnect cancels the upstream response body", async () => {
  let cancelled = false;
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const backend: Backend = {
    defaultModel: "mock-model",
    ports: borrowedBackendPorts("mock-model"),
    chat: () =>
      Effect.succeed(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller;
              controller.enqueue(
                Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
              );
            },
            cancel() {
              cancelled = true;
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      ),
    models: () => Effect.succeed(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    embeddings: () => Effect.succeed(new Response(JSON.stringify({}), { status: 200 }))
  };
  const gateway = await startGateway({ backend });
  const aborter = new AbortController();
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      }),
      signal: aborter.signal
    });
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    await reader.read();
    aborter.abort();

    const deadline = Date.now() + 1_000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!cancelled) upstreamController?.close();
    assert.equal(cancelled, true, "the gateway must cancel a body it can no longer deliver");
  } finally {
    try {
      upstreamController?.close();
    } catch {
      // already cancelled
    }
    await Effect.runPromise(gateway.close);
  }
});

test("oversized request bodies are rejected before the backend is called", async () => {
  let chatCalls = 0;
  const backend: Backend = {
    defaultModel: "mock-model",
    ports: borrowedBackendPorts("mock-model"),
    chat: () => {
      chatCalls += 1;
      return Effect.succeed(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    },
    models: () => Effect.succeed(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    embeddings: () => Effect.succeed(new Response(JSON.stringify({}), { status: 200 }))
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        messages: [{ role: "user", content: "hi" }],
        padding: "x".repeat(17 * 1024 * 1024)
      })
    });

    assert.equal(response.status, 413);
    assert.equal(chatCalls, 0);
  } finally {
    await Effect.runPromise(gateway.close);
  }
});

test("stream backpressure does not retain close listeners", async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error): void => {
    if (
      warning.name === "MaxListenersExceededWarning" &&
      warning.message.includes("ServerResponse")
    ) {
      warnings.push(warning);
    }
  };
  process.on("warning", onWarning);

  const chunk = Buffer.alloc(128 * 1024, "x");
  const chunkCount = 24;
  let emitted = 0;
  const backend: Backend = {
    defaultModel: "mock-model",
    ports: borrowedBackendPorts("mock-model"),
    chat: () =>
      Effect.succeed(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (emitted === chunkCount) {
                controller.close();
                return;
              }
              emitted += 1;
              controller.enqueue(chunk);
            }
          }),
          { status: 200, headers: { "content-type": "application/octet-stream" } }
        )
      ),
    models: () => Effect.succeed(Response.json({ data: [] })),
    embeddings: () => Effect.succeed(Response.json({}))
  };
  const gateway = await startGateway({ backend });
  const proxy = await startSwitchingGatewayProxy({ target: gateway.url() });
  try {
    const response = await fetch(`${proxy.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, chunk.length * chunkCount);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    process.off("warning", onWarning);
    await Effect.runPromise(proxy.close);
    await Effect.runPromise(gateway.close);
  }
});
