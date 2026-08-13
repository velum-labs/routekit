import type {
  AccountActivityCoordinator,
  AccountAuthCoordinator
} from "@velum-labs/routekit-accounts";
import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer } from "@velum-labs/routekit-runtime";
import { extendCleanupGrace, registerCleanup } from "@velum-labs/routekit-runtime";
import type { RouteKitManagedRuntime } from "@velum-labs/routekit-runtime/effect";

import { DaemonResourceScope } from "./daemon-resource-scope.js";
import type { DaemonRuntimeState } from "./daemon-runtime-state.js";
import type { DaemonTelemetry, GatewayTelemetryAggregator } from "./telemetry.js";

type Supervisor = "systemd" | "launchd" | "detached" | "unknown";

export type DaemonLifecycleOptions = {
  runtimeState: DaemonRuntimeState;
  handlers: RouteKitControlHandlers;
  drainGraceMs: number;
  packageVersion: string;
  supervisor: Supervisor;
  getProxy(): SwitchingGatewayProxy | undefined;
  getActiveRouter(): RunningRouter | undefined;
  getControl(): RunningControlServer | undefined;
  accountActivity?: AccountActivityCoordinator;
  accountAuth?: AccountAuthCoordinator;
  daemonTelemetry?: DaemonTelemetry;
  gatewayTelemetry?: GatewayTelemetryAggregator;
  closeSidecar(): Promise<void>;
  cleanupRegistration(): void;
  /** Disposed last so in-flight Effect work can finish during teardown. */
  effectRuntime?: RouteKitManagedRuntime;
};

export function captureDaemonStarted(input: {
  daemonTelemetry?: DaemonTelemetry;
  packageVersion: string;
  supervisor: Supervisor;
}): void {
  input.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
    action: "started",
    outcome: "success",
    supervisor: input.supervisor,
    version: input.packageVersion
  });
}

export function createDaemonLifecycle(options: DaemonLifecycleOptions): {
  close(): Promise<void>;
  retire(graceMs?: number): Promise<void>;
  pauseMutations(): Promise<ReturnType<DaemonRuntimeState["snapshot"]>>;
  resumeMutations(): void;
  snapshot(): ReturnType<DaemonRuntimeState["snapshot"]>;
  reload(): Promise<void>;
} {
  const shutdownResources = (mode: "close" | "retire", graceMs: number): DaemonResourceScope => {
    const scope = new DaemonResourceScope(graceMs + 10_000);
    // ResourceScope finalizers run in LIFO order. Stop ingress first, then
    // drain the data plane before closing its router and supporting resources.
    // Telemetry remains alive through operational shutdown and the service
    // registration is removed only after every owned resource was attempted.
    // The Effect runtime is registered first so it disposes last.
    scope.defer(async () => await options.effectRuntime?.dispose());
    scope.defer(() => options.cleanupRegistration());
    scope.defer(() => options.gatewayTelemetry?.close());
    scope.defer(async () => await options.daemonTelemetry?.shutdown());
    scope.defer(options.closeSidecar);
    if (options.accountAuth !== undefined) {
      scope.defer(() => options.accountAuth?.close());
    }
    if (options.accountActivity !== undefined) {
      scope.defer(() => options.accountActivity?.close());
    }
    scope.defer(async () => await options.getActiveRouter()?.close());
    scope.defer(async () => {
      if (mode === "retire") await options.getProxy()?.retire(graceMs);
      else await options.getProxy()?.drain(graceMs);
    });
    scope.defer(async () => {
      if (mode === "retire") await options.getControl()?.retire(Math.min(graceMs, 2_000));
      else await options.getControl()?.close();
    });
    return scope;
  };
  let removeSighupListener = (): void => {};
  let shutdownRun: Promise<void> | undefined;
  const shutdown = (mode: "close" | "retire", graceMs: number): Promise<void> => {
    shutdownRun ??= (async () => {
      if (mode === "close") options.runtimeState.beginShutdown();
      else options.runtimeState.beginRetire();
      try {
        await options.runtimeState.awaitMutations();
        if (mode === "close") {
          try {
            options.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
              action: "stopped",
              outcome: "success",
              supervisor: options.supervisor,
              version: options.packageVersion
            });
          } catch (error) {
            process.stderr.write(
              `routekit daemon stop telemetry failed: ${error instanceof Error ? error.message : String(error)}\n`
            );
          }
        }
        options.runtimeState.markDraining();
        await shutdownResources(mode, graceMs).dispose();
      } finally {
        removeSighupListener();
        options.runtimeState.markClosed();
      }
    })();
    return shutdownRun;
  };
  const close = (): Promise<void> => shutdown("close", options.drainGraceMs);

  extendCleanupGrace(options.drainGraceMs + 10_000);
  registerCleanup(close);
  const onSighup = (): void => {
    void reload(options.handlers, "sighup").catch((error: unknown) => {
      process.stderr.write(
        `routekit daemon reload failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  };
  process.on("SIGHUP", onSighup);
  removeSighupListener = () => process.off("SIGHUP", onSighup);

  return {
    close,
    retire: async (graceMs = options.drainGraceMs) => await shutdown("retire", graceMs),
    pauseMutations: async () => {
      options.runtimeState.pause();
      await options.runtimeState.awaitMutations();
      return options.runtimeState.snapshot();
    },
    resumeMutations: () => {
      options.runtimeState.resume();
    },
    snapshot: () => options.runtimeState.snapshot(),
    reload: async () => await reload(options.handlers, "direct")
  };
}

export async function cleanupFailedDaemon(input: {
  gatewayTelemetry?: GatewayTelemetryAggregator;
  daemonTelemetry?: DaemonTelemetry;
  proxy?: SwitchingGatewayProxy;
  activeRouter?: RunningRouter;
  accountActivity?: AccountActivityCoordinator;
  accountAuth?: AccountAuthCoordinator;
  closeSidecar(): Promise<void>;
  control?: RunningControlServer;
  cleanupRegistration(): void;
  effectRuntime?: RouteKitManagedRuntime;
}): Promise<void> {
  const scope = new DaemonResourceScope();
  scope.defer(async () => await input.effectRuntime?.dispose());
  scope.defer(() => input.cleanupRegistration());
  scope.defer(async () => await input.control?.close());
  scope.defer(input.closeSidecar);
  scope.defer(() => input.accountAuth?.close());
  scope.defer(() => input.accountActivity?.close());
  scope.defer(async () => await input.activeRouter?.close());
  scope.defer(async () => await input.proxy?.close());
  scope.defer(async () => await input.daemonTelemetry?.shutdown());
  scope.defer(() => input.gatewayTelemetry?.close());
  await scope.dispose();
}

function reload(handlers: RouteKitControlHandlers, requestId: string): Promise<void> {
  return Promise.resolve(
    handlers["daemon.reload"](
      {},
      {
        signal: new AbortController().signal,
        requestId
      }
    )
  ).then(() => undefined);
}
