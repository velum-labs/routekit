import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { startSwitchingGatewayProxy } from "../switching-proxy.js";

async function heldTarget(): Promise<{
  url: string;
  started: Promise<void>;
  release(): void;
  close(): Promise<void>;
}> {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === "/stream") {
      response.setHeader("content-type", "text/plain");
      response.write("first\n");
      markStarted();
      void released.then(() => response.end("last\n"));
      return;
    }
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    started,
    release,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      )
  };
}

test("switching proxy retirement preserves an admitted streaming response", async () => {
  const target = await heldTarget();
  const proxy = await startSwitchingGatewayProxy({ target: target.url });
  try {
    const response = await fetch(`${proxy.url()}/stream`);
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    const first = await reader.read();
    assert.match(Buffer.from(first.value ?? []).toString("utf8"), /first/);
    await target.started;

    const retiring = proxy.retire(2_000);
    target.release();
    let remainder = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      remainder += Buffer.from(value ?? []).toString("utf8");
    }
    assert.match(remainder, /last/);
    await retiring;
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("switching proxy retirement deadline terminates a stream that never finishes", async () => {
  const target = await heldTarget();
  const proxy = await startSwitchingGatewayProxy({ target: target.url });
  try {
    const response = await fetch(`${proxy.url()}/stream`);
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    await reader.read();
    await target.started;

    const startedAt = Date.now();
    await proxy.retire(250);
    assert.ok(Date.now() - startedAt >= 200);
    await assert.rejects(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
  } finally {
    target.release();
    await proxy.close();
    await target.close();
  }
});
