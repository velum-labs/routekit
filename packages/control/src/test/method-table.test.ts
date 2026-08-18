import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_OPERATIONS } from "@velum-labs/routekit-telemetry-core";
import {
  CONTROL_METHODS,
  controlAuthorization,
  controlIdempotency,
  controlMutation,
  controlOperation,
  controlSurface,
  isRouteKitControlMethod,
  MUTATING_ROUTEKIT_METHODS,
  ROUTEKIT_CONTROL_METHODS,
  resolveControlCallOptions
} from "../index.js";

test("method table is the source of truth for protocol methods and policy", () => {
  assert.equal(ROUTEKIT_CONTROL_METHODS.length, Object.keys(CONTROL_METHODS).length);
  assert.deepEqual(ROUTEKIT_CONTROL_METHODS, Object.keys(CONTROL_METHODS));
  assert.equal(isRouteKitControlMethod("accounts.enroll"), true);
  assert.equal(isRouteKitControlMethod("accounts.enroll.extra"), false);

  assert.equal(controlAuthorization("daemon.roll"), "ephemeral");
  assert.equal(controlAuthorization("daemon.status"), "authenticated");
  assert.equal(controlMutation("daemon.reload"), "mutation");
  assert.equal(controlMutation("models.list"), "query");
  assert.equal(controlIdempotency("daemon.reload"), "optional");
  assert.equal(controlIdempotency("evalSession.open"), "required");
  assert.equal(controlIdempotency("evalSession.close"), "required");
  assert.equal(controlIdempotency("evalRouting.activate"), "required");
  assert.equal(controlIdempotency("models.list"), "none");
  assert.equal(MUTATING_ROUTEKIT_METHODS.has("config.update"), true);
  assert.equal(MUTATING_ROUTEKIT_METHODS.has("models.list"), false);

  assert.equal(controlSurface("models.list"), "cli");
  assert.equal(controlSurface("accounts.sync"), "daemon");
  assert.equal(controlSurface("accounts.enroll"), "daemon");
  assert.equal(controlSurface("providers.set"), "daemon");
  assert.equal(controlSurface("telemetry.captureCommand"), "cli-internal");
  assert.equal(controlSurface("evalSession.open"), "cli-internal");
  assert.equal(controlSurface("evalRouting.status"), "cli-internal");
  assert.equal(controlSurface("evalRouting.activate"), "cli-internal");

  assert.equal(controlOperation("daemon.reload", {}), "config_reload");
  assert.equal(controlOperation("providers.set", { enabled: true }), "provider_enable");
  assert.equal(controlOperation("providers.set", { enabled: false }), "provider_disable");
  assert.equal(controlOperation("launcher.prepare", { tool: "codex" }), "launcher_prepare");
  assert.equal(controlOperation("models.list", {}), undefined);
});

test("method-table operations and PRODUCT_OPERATIONS stay in bijection", () => {
  const produced = new Set<string>();
  for (const method of ROUTEKIT_CONTROL_METHODS) {
    const spec = CONTROL_METHODS[method];
    if (!("operation" in spec) || spec.operation === undefined) continue;
    if (typeof spec.operation === "function") {
      if (method !== "providers.set") {
        throw new Error(`${method} has a parametric operation; extend this test with its branches`);
      }
      produced.add(controlOperation("providers.set", { enabled: true }) ?? "");
      produced.add(controlOperation("providers.set", { enabled: false }) ?? "");
      continue;
    }
    produced.add(spec.operation);
  }
  produced.delete("");
  assert.deepEqual([...produced].sort(), [...PRODUCT_OPERATIONS].sort());
});

test("product client call options follow method-table idempotency policy", () => {
  const signal = AbortSignal.timeout(1_000);
  assert.deepEqual(resolveControlCallOptions("models.list", { signal }), { signal });
  assert.deepEqual(
    resolveControlCallOptions("models.list", { signal, idempotencyKey: "query-1" } as never),
    { signal }
  );
  assert.deepEqual(
    resolveControlCallOptions("config.update", { idempotencyKey: "update-1", signal }),
    { signal, idempotencyKey: "update-1" }
  );
  assert.deepEqual(resolveControlCallOptions("config.update"), {});
  assert.deepEqual(resolveControlCallOptions("daemon.roll", { idempotencyKey: "roll-1" }), {
    idempotencyKey: "roll-1"
  });
});
