import {
  type ControlMethodRegistry,
  controlOperation,
  createRouteKitControlHandler,
  type RouteKitControlHandlers,
  type RouteKitControlMethod,
  type RouteKitControlParams
} from "@velum-labs/routekit-control";
import { ControlError, type ControlHandler } from "@velum-labs/routekit-runtime/control";
import { durationBucket } from "@velum-labs/routekit-telemetry-core";
import { createDaemonControlMethodRegistry } from "./application-services.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import type { DaemonTelemetry } from "./telemetry.js";

export type HostIdempotencyExecutor = <T>(input: {
  method: RouteKitControlMethod;
  key: string;
  params: RouteKitControlParams[RouteKitControlMethod];
  operation(): Promise<T>;
}) => Promise<T>;

export type DaemonControlDispatchOptions = {
  handlers: RouteKitControlHandlers;
  runtimeState: DaemonRuntimeState;
  packageVersion: string;
  daemonTelemetry?: DaemonTelemetry;
  executeIdempotent?: HostIdempotencyExecutor;
};

function captureOperation(
  options: DaemonControlDispatchOptions,
  method: RouteKitControlMethod,
  params: unknown,
  outcome: "success" | "error",
  durationMs: number
): void {
  const operation = controlOperation(method, params);
  if (operation === undefined) return;
  options.daemonTelemetry?.capture("routekit.product_operation_completed", {
    operation,
    outcome,
    duration_bucket: durationBucket(durationMs),
    version: options.packageVersion
  });
}

function enforceDefinition(
  registry: ControlMethodRegistry,
  runtimeState: DaemonRuntimeState,
  method: RouteKitControlMethod,
  context: Parameters<ControlHandler>[2]
): void {
  const definition = registry.definition(method);
  if (definition.authorization === "ephemeral" && context.principal?.role !== "ephemeral") {
    throw new ControlError({
      code: "unauthorized",
      message: `${method} requires the local service credential`
    });
  }
  if (definition.idempotency === "required" && context.idempotencyKey === undefined) {
    throw new ControlError({
      code: "bad_request",
      message: `${method} requires an idempotency key`
    });
  }
  if (runtimeState.lifecycle === "paused" && definition.mutation === "mutation") {
    throw new ControlError({
      code: "unavailable",
      message: "RouteKit daemon is synchronizing a replacement worker"
    });
  }
}

export function createDaemonControlDispatch(options: DaemonControlDispatchOptions): ControlHandler {
  const registry = createDaemonControlMethodRegistry(options.handlers);
  const registeredMethods = new Set(registry.list().map((definition) => definition.method));
  const routeKitDispatch = createRouteKitControlHandler(registry.handlers(), {
    registry,
    onCommitted: (method, params, durationMs) =>
      captureOperation(options, method, params, "success", durationMs),
    onControlError: (method, params, _code, durationMs) =>
      captureOperation(options, method, params, "error", durationMs)
  });

  return async (rawMethod, params, context) => {
    if (!registeredMethods.has(rawMethod as RouteKitControlMethod)) {
      return await routeKitDispatch(rawMethod, params, context);
    }
    const method = rawMethod as RouteKitControlMethod;
    enforceDefinition(registry, options.runtimeState, method, context);
    const definition = registry.definition(method);
    if (
      options.executeIdempotent !== undefined &&
      definition.mutation === "mutation" &&
      context.idempotencyKey !== undefined
    ) {
      return await options.executeIdempotent({
        method,
        key: context.idempotencyKey,
        params: params as RouteKitControlParams[RouteKitControlMethod],
        operation: async () =>
          await routeKitDispatch(rawMethod, params, {
            ...context,
            idempotencyKey: undefined
          })
      });
    }
    return await routeKitDispatch(rawMethod, params, context);
  };
}
