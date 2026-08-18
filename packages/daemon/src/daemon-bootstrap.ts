/** Effect-owned singleton RouteKit daemon process composition. */
import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import { Effect, ManagedRuntime } from "effect";

import { type DaemonLive, daemonLive } from "./effect/daemon-live.js";
import { DaemonRuntime } from "./services/daemon-runtime/service.js";

export const ROUTEKIT_DAEMON_KIND = "daemon";
export const ROUTEKIT_PRODUCT = "routekit";

export type { RouteKitDaemonOptions } from "./daemon-options.js";
import type { RouteKitDaemonOptions } from "./daemon-options.js";

export type RunningRouteKitDaemon = {
  record: ServiceRecord;
  dataUrl: string;
  controlUrl: string;
  close(): Promise<void>;
  retire(graceMs?: number): Promise<void>;
  pauseMutations(): Promise<{
    configRevision: number;
    accountRevision: number;
    configHash: string;
  }>;
  resumeMutations(): void;
  snapshot(): {
    configRevision: number;
    accountRevision: number;
    configHash: string;
  };
  reload(): Promise<void>;
};

export type RouteKitDaemonManagedRuntime = ManagedRuntime.ManagedRuntime<DaemonLive, Error>;

/** Construct the one runtime that owns a daemon worker or standalone daemon. */
export function makeRouteKitDaemonRuntime(
  options: RouteKitDaemonOptions
): RouteKitDaemonManagedRuntime {
  return ManagedRuntime.make(daemonLive(options));
}

/** Adapt an already-owned daemon runtime to the published Promise façade. */
export async function runningRouteKitDaemon(
  runtime: RouteKitDaemonManagedRuntime
): Promise<RunningRouteKitDaemon> {
  const running = await runtime.runPromise(DaemonRuntime);
  let closeRun: Promise<void> | undefined;
  const dispose = (prepare: Effect.Effect<void, Error, DaemonLive>): Promise<void> => {
    closeRun ??= runtime
      .runPromise(prepare)
      .then(() => undefined)
      .finally(async () => await runtime.dispose());
    return closeRun;
  };
  return {
    record: running.record,
    dataUrl: running.dataUrl,
    controlUrl: running.controlUrl,
    close: () => dispose(running.prepareClose),
    retire: (graceMs) => dispose(running.prepareRetire(graceMs)),
    pauseMutations: () => runtime.runPromise(running.pauseMutations),
    resumeMutations: () => {
      runtime.runFork(running.resumeMutations);
    },
    snapshot: () => runtime.runSync(running.snapshot),
    reload: () => runtime.runPromise(running.reload)
  };
}

/** Published Promise façade over a standalone daemon ManagedRuntime. */
export async function bootstrapRouteKitDaemon(
  options: RouteKitDaemonOptions
): Promise<RunningRouteKitDaemon> {
  const runtime = makeRouteKitDaemonRuntime(options);
  try {
    return await runningRouteKitDaemon(runtime);
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
}
