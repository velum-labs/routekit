import assert from "node:assert/strict";
import test from "node:test";

import { routeKitControlSchemas } from "../index.js";
import { ControlMethodRegistry } from "../method-registry.js";
import type { RouteKitControlHandlers } from "../protocol.js";

test("method registry records declarative execution policy", () => {
  const handlers = {
    "daemon.status": async () => ({})
  } as unknown as RouteKitControlHandlers;
  const registry = new ControlMethodRegistry();
  registry.register({
    method: "daemon.status",
    ...routeKitControlSchemas("daemon.status"),
    authorization: "ephemeral",
    mutation: "query",
    idempotency: "none",
    handler: handlers["daemon.status"]
  });
  const definition = registry.definition("daemon.status");
  assert.equal(definition.authorization, "ephemeral");
  assert.equal(definition.mutation, "query");
  assert.equal(definition.idempotency, "none");
  assert.equal(registry.handlers()["daemon.status"], handlers["daemon.status"]);
  assert.equal(definition.paramsSchema.name, "daemon.status.params");
  assert.deepEqual(definition.paramsSchema.parse({}), {});
  assert.throws(
    () => definition.resultSchema.parse({ protocolVersion: "control.v2" }),
    /invalid result field: pid/
  );
});
