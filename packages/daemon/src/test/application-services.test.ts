import assert from "node:assert/strict";
import test from "node:test";

import type { RouteKitControlHandlers, RouteKitControlMethod } from "@velum-labs/routekit-control";

import { AccountApplicationService } from "../account-application-service.js";
import { createDaemonControlMethodRegistry } from "../application-services.js";
import { ProviderQueryService } from "../provider-query-service.js";
import { RouterGenerationService } from "../router-generation-service.js";

const handlers = new Proxy(
  {},
  {
    get: (_target, method) => async () => String(method)
  }
) as RouteKitControlHandlers;

test("daemon application services register disjoint owned method groups", () => {
  const registry = createDaemonControlMethodRegistry(handlers);
  const definitions = registry.list();
  const methods = definitions.map(({ method }) => method);
  assert.equal(new Set(methods).size, methods.length);
  assert.equal(methods.length, 33);

  const enroll = registry.definition("accounts.enroll");
  assert.deepEqual(
    {
      method: enroll.method,
      paramsSchema: enroll.paramsSchema.name,
      resultSchema: enroll.resultSchema.name,
      authorization: enroll.authorization,
      mutation: enroll.mutation,
      idempotency: enroll.idempotency
    },
    {
      method: "accounts.enroll",
      paramsSchema: "accounts.enroll.params",
      resultSchema: "accounts.enroll.result",
      authorization: "authenticated",
      mutation: "mutation",
      idempotency: "optional"
    }
  );
  assert.equal(registry.definition("models.list").mutation, "query");
  assert.equal(registry.definition("daemon.reload").mutation, "mutation");
  assert.equal(registry.definition("daemon.roll").authorization, "ephemeral");
});

test("application services expose concrete bounded handler groups", () => {
  const accounts = new AccountApplicationService({} as never).handlers();
  const provider = new ProviderQueryService({} as never).handlers();
  const router = new RouterGenerationService({} as never).handlers();
  assert.deepEqual(Object.keys(accounts).sort(), [
    "accounts.enroll",
    "accounts.enrollActivate",
    "accounts.list",
    "accounts.redeemReset",
    "accounts.remove",
    "accounts.rename",
    "accounts.resetCredits",
    "accounts.status",
    "accounts.sync",
    "accounts.usage"
  ]);
  assert.deepEqual(Object.keys(provider).sort(), [
    "calls.inspect",
    "calls.leaderboard",
    "models.info",
    "models.list",
    "providers.status"
  ]);
  assert.deepEqual(Object.keys(router).sort(), [
    "config.get",
    "config.import",
    "config.update",
    "daemon.reload",
    "providers.set"
  ]);
});
