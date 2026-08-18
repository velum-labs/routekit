import assert from "node:assert/strict";
import test from "node:test";
import type { RouterConfig } from "@velum-labs/routekit-config";
import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams
} from "@velum-labs/routekit-control";
import type { ControlHandlerContext } from "@velum-labs/routekit-runtime/control";

import { createDaemonControlDispatch } from "../control-dispatch.js";
import { DaemonRuntimeState } from "../daemon-runtime-state.js";
import type { DaemonTelemetry } from "../telemetry.js";

const config = { providers: {} } as RouterConfig;

function runtimeState(initiallyPaused = false): DaemonRuntimeState {
  return new DaemonRuntimeState({
    config,
    document: "providers: {}\n",
    revisions: { daemon: 1, config: 2, accounts: 3 },
    initiallyPaused
  });
}

function handlers(calls: { method: string; key?: string }[]): RouteKitControlHandlers {
  return new Proxy(
    {},
    {
      get: (_target, method) => async (_params: unknown, context: ControlHandlerContext) => {
        calls.push({
          method: String(method),
          ...(context.idempotencyKey !== undefined ? { key: context.idempotencyKey } : {})
        });
        if (method === "config.update" || method === "providers.set") {
          return { path: "/tmp/router.yaml", document: "providers: {}\n", revision: 3 };
        }
        if (method === "models.list") return { models: [], revision: 2 };
        return {};
      }
    }
  ) as RouteKitControlHandlers;
}

const context = (input: Partial<ControlHandlerContext> = {}): ControlHandlerContext => ({
  signal: AbortSignal.timeout(5_000),
  requestId: "test-request",
  ...input
});

test("daemon control dispatch enforces declarative authorization", async () => {
  const dispatch = createDaemonControlDispatch({
    handlers: handlers([]),
    runtimeState: runtimeState(),
    packageVersion: "1.2.3"
  });
  await assert.rejects(
    async () => await dispatch("daemon.roll", { reason: "restart" }, context()),
    /requires the local service credential/
  );
});

test("daemon control dispatch rejects mutations while the worker is paused", async () => {
  const dispatch = createDaemonControlDispatch({
    handlers: handlers([]),
    runtimeState: runtimeState(true),
    packageVersion: "1.2.3"
  });
  await assert.rejects(
    async () =>
      await dispatch(
        "config.update",
        { expectedRevision: 2, document: "providers: {}\n" },
        context()
      ),
    /synchronizing a replacement worker/
  );
});

test("daemon control dispatch delegates keyed mutations to host idempotency", async () => {
  const calls: { method: string; key?: string }[] = [];
  const hosted: {
    method?: RouteKitControlMethod;
    key?: string;
    params?: RouteKitControlParams[RouteKitControlMethod];
  } = {};
  const dispatch = createDaemonControlDispatch({
    handlers: handlers(calls),
    runtimeState: runtimeState(),
    packageVersion: "1.2.3",
    executeIdempotent: async (input) => {
      hosted.method = input.method;
      hosted.key = input.key;
      hosted.params = input.params;
      return await input.operation();
    }
  });
  const params = { expectedRevision: 2, document: "providers: {}\n" };
  await dispatch("config.update", params, context({ idempotencyKey: "update-1" }));
  assert.deepEqual(hosted, { method: "config.update", key: "update-1", params });
  assert.deepEqual(calls, [{ method: "config.update" }]);
});

test("daemon control dispatch preserves query idempotency keys without host delegation", async () => {
  const calls: { method: string; key?: string }[] = [];
  let hostCalls = 0;
  const dispatch = createDaemonControlDispatch({
    handlers: handlers(calls),
    runtimeState: runtimeState(),
    packageVersion: "1.2.3",
    executeIdempotent: async (input) => {
      hostCalls += 1;
      return await input.operation();
    }
  });
  await dispatch("models.list", {}, context({ idempotencyKey: "query-1" }));
  assert.equal(hostCalls, 0);
  assert.deepEqual(calls, [{ method: "models.list", key: "query-1" }]);
});

test("daemon control dispatch reports product operations from the method table", async () => {
  const captured: string[] = [];
  const dispatch = createDaemonControlDispatch({
    handlers: handlers([]),
    runtimeState: runtimeState(),
    packageVersion: "1.2.3",
    daemonTelemetry: {
      capture: (name, properties) => {
        if (name === "routekit.product_operation_completed" && "operation" in properties) {
          captured.push(String(properties.operation));
        }
        return true;
      }
    } as DaemonTelemetry
  });
  await dispatch("config.update", { expectedRevision: 2, document: "providers: {}\n" }, context());
  await dispatch("models.list", {}, context());
  await dispatch("providers.set", { provider: "openai", enabled: true }, context());
  assert.deepEqual(captured, ["config_update", "provider_enable"]);
});

test("daemon control dispatch rejects structurally invalid handler results", async () => {
  const invalidHandlers = new Proxy(
    {},
    {
      get: () => async () => ({ models: "not-an-array", revision: 2 })
    }
  ) as RouteKitControlHandlers;
  const dispatch = createDaemonControlDispatch({
    handlers: invalidHandlers,
    runtimeState: runtimeState(),
    packageVersion: "1.2.3"
  });

  await assert.rejects(
    async () => await dispatch("models.list", {}, context()),
    (error: unknown) =>
      error instanceof Error &&
      /models\.list handler returned an invalid result field: models/.test(error.message)
  );
});
