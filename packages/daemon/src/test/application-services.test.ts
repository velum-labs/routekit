import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTEKIT_CONTROL_METHODS,
  type RouteKitControlHandlers
} from "@velum-labs/routekit-control";

import { AccountApplicationService } from "../account-application-service.js";
import { createDaemonControlMethodRegistry } from "../application-services.js";
import { DaemonLifecycleService } from "../daemon-lifecycle-service.js";
import { DoctorApplicationService } from "../doctor-application-service.js";
import { LauncherApplicationService } from "../launcher-application-service.js";
import { ProviderQueryService } from "../provider-query-service.js";
import { RouterGenerationService } from "../router-generation-service.js";
import { TelemetryApplicationService } from "../telemetry-application-service.js";
import { TokenApplicationService } from "../token-application-service.js";

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
  assert.equal(methods.length, ROUTEKIT_CONTROL_METHODS.length);

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
  assert.deepEqual(Object.keys(new DaemonLifecycleService({} as never).handlers()).sort(), [
    "daemon.prepareShutdown",
    "daemon.roll",
    "daemon.status"
  ]);
  assert.deepEqual(Object.keys(new DoctorApplicationService({} as never).handlers()), [
    "doctor.run"
  ]);
  assert.deepEqual(Object.keys(new LauncherApplicationService({} as never).handlers()), [
    "launcher.prepare"
  ]);
  assert.deepEqual(Object.keys(new TokenApplicationService({} as never).handlers()).sort(), [
    "tokens.issue",
    "tokens.list",
    "tokens.revoke"
  ]);
  assert.deepEqual(Object.keys(new TelemetryApplicationService({} as never).handlers()).sort(), [
    "telemetry.captureCommand",
    "telemetry.get",
    "telemetry.resetIdentity",
    "telemetry.schema",
    "telemetry.set"
  ]);
});
