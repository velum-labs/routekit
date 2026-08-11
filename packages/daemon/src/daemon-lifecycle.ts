import type { AccountActivityCoordinator, AccountAuthCoordinator } from "@velum-labs/routekit-accounts";
import type { RouteKitControlHandlers } from "@velum-labs/routekit-control";
import type { SwitchingGatewayProxy } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import type { RunningControlServer } from "@velum-labs/routekit-runtime";
import { extendCleanupGrace, registerCleanup } from "@velum-labs/routekit-runtime";

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
  let closeRun: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeRun ??= (async () => {
      options.runtimeState.beginShutdown();
      await options.runtimeState.awaitMutations();
      options.gatewayTelemetry?.close();
      options.daemonTelemetry?.capture("routekit.daemon_lifecycle", {
        action: "stopped",
        outcome: "success",
        supervisor: options.supervisor,
        version: options.packageVersion
      });
      await options.daemonTelemetry?.shutdown();
      options.runtimeState.markDraining();
      await options.getProxy()?.drain(options.drainGraceMs);
      await options.getActiveRouter()?.close();
      options.accountActivity?.close();
      options.accountAuth?.close();
      await options.closeSidecar();
      await options.getControl()?.close();
      options.cleanupRegistration();
      options.runtimeState.markClosed();
    })();
    return closeRun;
  };

  extendCleanupGrace(options.drainGraceMs + 10_000);
  registerCleanup(close);
  process.on("SIGHUP", () => {
    void reload(options.handlers, "sighup").catch((error: unknown) => {
      process.stderr.write(
        `routekit daemon reload failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  });

  return {
    close,
    retire: async (graceMs = options.drainGraceMs) => {
      if (!options.runtimeState.beginRetire()) return;
      await options.runtimeState.awaitMutations();
      options.runtimeState.markDraining();
      await Promise.all([
        options.getProxy()?.retire(graceMs),
        options.getControl()?.retire(Math.min(graceMs, 2_000))
      ]);
      await options.getActiveRouter()?.close();
      options.accountActivity?.close();
      options.accountAuth?.close();
      options.gatewayTelemetry?.close();
      await options.daemonTelemetry?.shutdown();
      options.runtimeState.markClosed();
    },
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
}): Promise<void> {
  input.gatewayTelemetry?.close();
  await input.daemonTelemetry?.shutdown();
  await input.proxy?.close();
  await input.activeRouter?.close();
  input.accountActivity?.close();
  input.accountAuth?.close();
  await input.closeSidecar();
  await input.control?.close();
  input.cleanupRegistration();
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
