import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime";

import { DaemonRuntimeState } from "../daemon-runtime-state.js";

test("daemon runtime state serializes mutations and exposes a stable snapshot", async () => {
  const state = new DaemonRuntimeState({
    config: parseRouterConfig({ providers: {} }),
    document: "providers: {}\n",
    revisions: { config: 3, accounts: 7, daemon: 11 }
  });
  const order: string[] = [];
  const first = state.serializeMutation(async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("first-end");
    return "first";
  });
  const second = state.serializeMutation(async () => {
    order.push("second");
    return "second";
  });

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.deepEqual(state.snapshot(), {
    configRevision: 3,
    accountRevision: 7,
    configHash: "71f126fdb588ade22462e2adde427ff4e7533d2fe672b7ca97aba8ab7863eabd"
  });
});

test("daemon runtime state gates pause, resume, retire, and shutdown transitions", async () => {
  const state = new DaemonRuntimeState({
    config: parseRouterConfig({ providers: {} }),
    document: "providers: {}\n",
    revisions: { config: 0, accounts: 0, daemon: 0 }
  });

  state.pause();
  assert.equal(state.lifecycle, "paused");
  await assert.rejects(
    () => state.serializeMutation(async () => undefined),
    (error: unknown) => error instanceof ControlError && error.code === "unavailable"
  );
  state.resume();
  assert.equal(state.lifecycle, "running");

  assert.equal(state.beginRetire(), true);
  assert.equal(state.lifecycle, "quiescing");
  assert.equal(state.draining, true);
  assert.equal(state.beginRetire(), false);
  state.markDraining();
  assert.equal(state.lifecycle, "draining");
  assert.equal(state.beginRetire(), false);

  state.markClosed();
  assert.equal(state.lifecycle, "closed");
  state.beginShutdown();
  assert.equal(state.closed, true);
  assert.equal(state.draining, true);
});
