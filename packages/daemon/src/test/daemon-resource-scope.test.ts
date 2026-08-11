import assert from "node:assert/strict";
import test from "node:test";

import { DaemonResourceScope } from "../daemon-resource-scope.js";

test("daemon resource scope distinguishes owned and borrowed resources", async () => {
  const finalized: string[] = [];
  const scope = new DaemonResourceScope();
  const borrowed = scope.borrow({ name: "host-sidecar" });
  scope.own({ name: "worker-router" }, async (resource) => {
    finalized.push(resource.name);
  });

  await scope.dispose();
  assert.equal(borrowed.name, "host-sidecar");
  assert.deepEqual(finalized, ["worker-router"]);
});

test("daemon resource scope transfers startup ownership after publication", async () => {
  const finalized: string[] = [];
  const startup = new DaemonResourceScope();
  const running = new DaemonResourceScope();
  startup.defer(() => {
    finalized.push("router");
  });
  startup.transferTo(running);

  await startup.dispose();
  assert.deepEqual(finalized, []);
  await running.dispose();
  assert.deepEqual(finalized, ["router"]);
});
