import assert from "node:assert/strict";
import test from "node:test";

import { createToolLaunchContext } from "../launch-context.js";
import type { ToolLaunchSpec } from "../types.js";

const spec: ToolLaunchSpec = {
  gatewayUrl: "https://gateway.test",
  defaultModel: "model-a",
  models: [{ id: "model-a" }],
  args: []
};

test("tool launch context owns registered resources in LIFO order", async () => {
  const calls: string[] = [];
  const log = (line: string): void => {
    calls.push(`log:${line}`);
  };
  const launch = createToolLaunchContext({
    spec,
    log,
    prepareForPassthrough: () => {
      calls.push("prepare");
    },
    registerPort: (name, port) => `${name}:${port}`,
    unregisterPort: (name) => {
      calls.push(`unregister:${name}`);
    }
  });

  assert.equal(launch.context.spec, spec);
  assert.equal(launch.context.log, log);
  assert.equal(launch.context.registerPort("gateway", 8080), "gateway:8080");
  launch.context.prepareForPassthrough();
  launch.context.unregisterPort("gateway");
  launch.context.registerDisposer(() => {
    calls.push("dispose:first");
  });
  launch.context.registerDisposer(() => {
    calls.push("dispose:second");
  });
  const firstDispose = launch.dispose();
  const secondDispose = launch.dispose();
  assert.equal(secondDispose, firstDispose);
  await firstDispose;

  assert.deepEqual(calls, ["prepare", "unregister:gateway", "dispose:second", "dispose:first"]);
  assert.throws(
    () => launch.context.registerDisposer(() => {}),
    /resource scope is no longer accepting resources/
  );
});

test("tool launch context attempts every finalizer before reporting cleanup failures", async () => {
  const calls: string[] = [];
  const launch = createToolLaunchContext({
    spec,
    log: () => {},
    prepareForPassthrough: () => {},
    registerPort: (name, port) => `${name}:${port}`,
    unregisterPort: () => {}
  });
  launch.context.registerDisposer(() => {
    calls.push("first");
    throw new Error("first failed");
  });
  launch.context.registerDisposer(() => {
    calls.push("second");
    throw new Error("second failed");
  });

  await assert.rejects(launch.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((entry) => (entry as Error).message),
      ["second failed", "first failed"]
    );
    return true;
  });
  assert.deepEqual(calls, ["second", "first"]);
});
