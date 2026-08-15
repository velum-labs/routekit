import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { runRouteKitEffect } from "../effect-api.js";
import {
  acquireLifecycleLock,
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  ControlError,
  type ControlTransport,
  startControlServer
} from "../index.js";

test("control server authenticates health/calls and negotiates control.v2", async () => {
  const server = await startControlServer({
    product: "testkit",
    packageVersion: "1.2.3",
    capabilities: ["test.v1"],
    handler: async (method, params) => ({ method, params })
  });
  try {
    assert.equal((await fetch(`${server.url}/control/v2/health`)).status, 401);
    const client = new ControlClient({ url: server.url, token: server.token });
    assert.deepEqual(await runRouteKitEffect(client.health()), {
      protocol: CONTROL_PROTOCOL_VERSION,
      version: "1.2.3"
    });
    const hello = await runRouteKitEffect(
      client.call<{
        protocolVersion: string;
        capabilities: string[];
      }>("hello")
    );
    assert.equal(hello.protocolVersion, CONTROL_PROTOCOL_VERSION);
    assert.deepEqual(hello.capabilities, ["test.v1"]);
    assert.deepEqual(await runRouteKitEffect(client.call("echo", { value: 3 })), {
      method: "echo",
      params: { value: 3 }
    });
  } finally {
    await runRouteKitEffect(server.close);
  }
});

test("control server reports unexpected handler errors without exposing details", async () => {
  const failure = new Error("provider token leaked into an internal failure");
  const observed: Array<{
    error: unknown;
    context: { requestId: string; method?: string };
  }> = [];
  const server = await startControlServer({
    handler: async () => {
      throw failure;
    },
    onError: (error, context) => observed.push({ error, context })
  });
  try {
    const client = new ControlClient({ url: server.url, token: server.token });
    await assert.rejects(
      runRouteKitEffect(client.call("models.list", {}, { requestId: "diagnostic-request" })),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === "internal" &&
        error.message === "control operation failed"
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.error, failure);
    assert.deepEqual(observed[0]?.context, {
      requestId: "diagnostic-request",
      method: "models.list"
    });
  } finally {
    await runRouteKitEffect(server.close);
  }
});

test("control transport rejects wrong tokens, hosts, protocols, and content types", async () => {
  let calls = 0;
  const server = await startControlServer({
    handler: async () => {
      calls += 1;
      return {};
    }
  });
  try {
    const wrong = new ControlClient({ url: server.url, token: "wrong" });
    await assert.rejects(runRouteKitEffect(wrong.health()));
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${server.url}/control/v2/health`,
        {
          headers: {
            authorization: `Bearer ${server.token}`,
            host: "evil.example"
          }
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      request.once("error", reject);
      request.end();
    });
    assert.equal(badHostStatus, 403);
    const text = await fetch(`${server.url}/control/v2/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "text/plain"
      },
      body: "{}"
    });
    assert.equal(text.status, 400);
    const oldProtocol = await fetch(`${server.url}/control/v2/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        protocol: "control.v0",
        id: "old",
        method: "echo"
      })
    });
    assert.equal(oldProtocol.status, 426);
    const body = (await oldProtocol.json()) as {
      error?: { code?: string; details?: { supported?: string[] } };
    };
    assert.equal(body.error?.code, "upgrade_required");
    assert.deepEqual(body.error?.details?.supported, [CONTROL_PROTOCOL_VERSION]);
    assert.equal(calls, 0);
  } finally {
    await runRouteKitEffect(server.close);
  }
});
test("control transport streams NDJSON events and structured failures", async () => {
  const server = await startControlServer({
    handler: (method) => {
      if (method === "fail") {
        throw new ControlError({ code: "conflict", message: "revision changed" });
      }
      return (async function* () {
        yield 1;
        yield 2;
      })();
    }
  });
  try {
    const client = new ControlClient({ url: server.url, token: server.token });
    const values: number[] = [];
    for await (const value of client.stream<number>("events")) values.push(value);
    assert.deepEqual(values, [1, 2]);
    await assert.rejects(
      runRouteKitEffect(client.call("fail")),
      (error: unknown) =>
        error instanceof ControlError &&
        error.code === "conflict" &&
        error.message === "revision changed"
    );
  } finally {
    await runRouteKitEffect(server.close);
  }
});

test("control client rejects truncated streams without a terminal event", async () => {
  const transport: ControlTransport = {
    health: () => Effect.succeed(new Response("{}", { status: 200 })),
    call: () => Effect.succeed(new Response("{}", { status: 200 })),
    stream: (_request, _signal) => {
      const request = _request;
      return Effect.succeed(
        new Response(
          `${JSON.stringify({
            protocol: CONTROL_PROTOCOL_VERSION,
            id: request.id,
            event: "data",
            data: 1
          })}\n`,
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      );
    }
  };
  const client = new ControlClient({
    transport
  });
  await assert.rejects(async () => {
    for await (const _value of client.stream("events")) {
      // consume
    }
  }, /without a terminal event/);
});

test("lifecycle lock serializes contenders and reaps dead owners", async () => {
  const home = mkdtempSync(join(tmpdir(), "lifecycle-lock-"));
  const path = join(home, "daemon.lock");
  try {
    const first = await acquireLifecycleLock(path);
    await assert.rejects(
      acquireLifecycleLock(path, { timeoutMs: 100, pollMs: 10 }),
      /owned by pid/
    );
    first.release();
    const second = await acquireLifecycleLock(path, { timeoutMs: 100 });
    second.release();

    writeFileSync(
      path,
      JSON.stringify({
        pid: 2 ** 22 + 123,
        nonce: "dead",
        acquiredAt: new Date(Date.now() - 5_000).toISOString()
      })
    );
    const recovered = await acquireLifecycleLock(path, { timeoutMs: 100 });
    recovered.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a freshly published partial lock is never stolen", async () => {
  const home = mkdtempSync(join(tmpdir(), "lifecycle-partial-"));
  const path = join(home, "daemon.lock");
  try {
    writeFileSync(path, "");
    await assert.rejects(acquireLifecycleLock(path, { timeoutMs: 100, pollMs: 10 }), /timed out/);
    assert.equal(existsSync(path), true);
    const old = new Date(Date.now() - 5_000);
    utimesSync(path, old, old);
    const recovered = await acquireLifecycleLock(path, {
      timeoutMs: 500,
      pollMs: 10
    });
    recovered.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
