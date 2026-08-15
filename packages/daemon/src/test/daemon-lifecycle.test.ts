import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { createDaemonLifecycle } from "../daemon-lifecycle.js";
import { DaemonRuntimeState } from "../daemon-runtime-state.js";

test("normal close removes SIGHUP listener and shuts resources down in dependency order", async () => {
  const order: string[] = [];
  const listenersBefore = process.listenerCount("SIGHUP");
  const runtimeState = new DaemonRuntimeState({
    config: parseRouterConfig({ providers: {} }),
    document: "providers: {}\n",
    revisions: { config: 0, accounts: 0, daemon: 0 }
  });
  const lifecycle = createDaemonLifecycle({
    runtimeState,
    handlers: {} as never,
    drainGraceMs: 0,
    packageVersion: "test",
    supervisor: "unknown",
    getControl: () =>
      ({
        close: async () => {
          order.push("control");
        }
      }) as never,
    getProxy: () =>
      ({
        drain: () =>
          Effect.sync(() => {
            order.push("proxy");
          })
      }) as never,
    getActiveRouter: () =>
      ({
        close: Effect.sync(() => {
          order.push("router");
        })
      }) as never,
    closeSidecar: () =>
      Effect.sync(() => {
        order.push("sidecar");
      }),
    daemonTelemetry: {
      capture: () => undefined,
      shutdown: async () => {
        order.push("daemon-telemetry");
      }
    } as never,
    gatewayTelemetry: {
      close: () => {
        order.push("gateway-telemetry");
      }
    } as never,
    cleanupRegistration: () => {
      order.push("registration");
    }
  });

  assert.equal(process.listenerCount("SIGHUP"), listenersBefore + 1);
  await runRouteKitEffect(lifecycle.close());
  assert.equal(process.listenerCount("SIGHUP"), listenersBefore);
  assert.deepEqual(order, [
    "control",
    "proxy",
    "router",
    "sidecar",
    "daemon-telemetry",
    "gateway-telemetry",
    "registration"
  ]);
  assert.equal(runtimeState.lifecycle, "closed");

  await runRouteKitEffect(lifecycle.close());
  assert.equal(process.listenerCount("SIGHUP"), listenersBefore);
});

test("normal close removes SIGHUP listener even when a finalizer fails", async () => {
  const listenersBefore = process.listenerCount("SIGHUP");
  const attempted: string[] = [];
  const lifecycle = createDaemonLifecycle({
    runtimeState: new DaemonRuntimeState({
      config: parseRouterConfig({ providers: {} }),
      document: "providers: {}\n",
      revisions: { config: 0, accounts: 0, daemon: 0 }
    }),
    handlers: {} as never,
    drainGraceMs: 0,
    packageVersion: "test",
    supervisor: "unknown",
    getControl: () => undefined,
    getProxy: () =>
      ({
        drain: () =>
          Effect.sync(() => attempted.push("proxy")).pipe(
            Effect.andThen(Effect.fail(new Error("drain failed")))
          )
      }) as never,
    getActiveRouter: () =>
      ({
        close: Effect.sync(() => {
          attempted.push("router");
        })
      }) as never,
    closeSidecar: () =>
      Effect.sync(() => {
        attempted.push("sidecar");
      }),
    cleanupRegistration: () => {
      attempted.push("registration");
    }
  });

  assert.equal(process.listenerCount("SIGHUP"), listenersBefore + 1);
  await assert.rejects(runRouteKitEffect(lifecycle.close()), AggregateError);
  assert.deepEqual(attempted, ["proxy", "router", "sidecar", "registration"]);
  assert.equal(process.listenerCount("SIGHUP"), listenersBefore);
});

test("close and retire share one globally idempotent disposal", async () => {
  const calls = new Map<string, number>();
  const record = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };
  const runtimeState = new DaemonRuntimeState({
    config: parseRouterConfig({ providers: {} }),
    document: "providers: {}\n",
    revisions: { config: 0, accounts: 0, daemon: 0 }
  });
  const lifecycle = createDaemonLifecycle({
    runtimeState,
    handlers: {} as never,
    drainGraceMs: 0,
    packageVersion: "test",
    supervisor: "unknown",
    getControl: () =>
      ({
        close: async () => record("control-close"),
        retire: async () => record("control-retire")
      }) as never,
    getProxy: () =>
      ({
        drain: () => Effect.sync(() => record("proxy-drain")),
        retire: () => Effect.sync(() => record("proxy-retire"))
      }) as never,
    getActiveRouter: () =>
      ({
        close: Effect.sync(() => record("router"))
      }) as never,
    closeSidecar: () => Effect.sync(() => record("sidecar")),
    cleanupRegistration: () => record("registration")
  });

  const closeRun = runRouteKitEffect(lifecycle.close());
  const retireRun = runRouteKitEffect(lifecycle.retire());
  await Promise.all([
    closeRun,
    retireRun,
    runRouteKitEffect(lifecycle.close()),
    runRouteKitEffect(lifecycle.retire())
  ]);

  assert.deepEqual(Object.fromEntries(calls), {
    "control-close": 1,
    "proxy-drain": 1,
    router: 1,
    sidecar: 1,
    registration: 1
  });
  assert.equal(runtimeState.lifecycle, "closed");
});

test("retire owns disposal when it wins the shutdown race", async () => {
  const order: string[] = [];
  const lifecycle = createDaemonLifecycle({
    runtimeState: new DaemonRuntimeState({
      config: parseRouterConfig({ providers: {} }),
      document: "providers: {}\n",
      revisions: { config: 0, accounts: 0, daemon: 0 }
    }),
    handlers: {} as never,
    drainGraceMs: 0,
    packageVersion: "test",
    supervisor: "unknown",
    getControl: () =>
      ({
        close: async () => order.push("control-close"),
        retire: async () => order.push("control-retire")
      }) as never,
    getProxy: () =>
      ({
        drain: () => Effect.sync(() => order.push("proxy-drain")),
        retire: () => Effect.sync(() => order.push("proxy-retire"))
      }) as never,
    getActiveRouter: () => undefined,
    closeSidecar: () => Effect.void,
    cleanupRegistration: () => undefined
  });

  await Promise.all([
    runRouteKitEffect(lifecycle.retire()),
    runRouteKitEffect(lifecycle.close()),
    runRouteKitEffect(lifecycle.retire())
  ]);
  assert.deepEqual(order, ["control-retire", "proxy-retire"]);
});
