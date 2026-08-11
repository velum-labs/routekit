import type {
  RouteKitControlHandlers,
  RouteKitControlMethod,
  RouteKitControlParams
} from "@velum-labs/routekit-control";
import {
  type ControlMethodRegistry,
  createRouteKitControlHandler
} from "@velum-labs/routekit-control";
import { ControlError, type ControlHandler } from "@velum-labs/routekit-runtime";
import { durationBucket, type TelemetryEventProperties } from "@velum-labs/routekit-telemetry-core";
import { createDaemonControlMethodRegistry } from "./application-services.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import type { DaemonTelemetry } from "./telemetry.js";

type ProductOperation =
  TelemetryEventProperties["routekit.product_operation_completed"]["operation"];

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

function operationFor(
  method: RouteKitControlMethod,
  params: unknown
): ProductOperation | undefined {
  switch (method) {
    case "daemon.reload":
      return "config_reload";
    case "config.update":
      return "config_update";
    case "config.import":
      return "config_import";
    case "providers.set":
      return (params as { enabled?: boolean }).enabled === true
        ? "provider_enable"
        : "provider_disable";
    case "accounts.enroll":
      return "account_enroll";
    case "accounts.enrollActivate":
      return "account_enroll_activate";
    case "accounts.remove":
      return "account_remove";
    case "accounts.sync":
      return "account_sync";
    case "launcher.prepare":
      return "launcher_prepare";
    case "tokens.issue":
      return "token_issue";
    case "tokens.revoke":
      return "token_revoke";
    default:
      return undefined;
  }
}

function captureOperation(
  options: DaemonControlDispatchOptions,
  method: RouteKitControlMethod,
  params: unknown,
  outcome: "success" | "error",
  durationMs: number
): void {
  const operation = operationFor(method, params);
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
