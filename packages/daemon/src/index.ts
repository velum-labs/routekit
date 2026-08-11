/**
 * Public daemon composition root.
 *
 * Startup mechanics, control handlers, and lifecycle ownership live in
 * daemon-owned application modules. This file only composes the public entry
 * points and intentionally contains no daemon runtime state.
 */
import {
  bootstrapRouteKitDaemon,
  type RouteKitDaemonOptions,
  type RunningRouteKitDaemon
} from "./daemon-bootstrap.js";

export type { RouteKitDaemonOptions, RunningRouteKitDaemon } from "./daemon-bootstrap.js";
export { ROUTEKIT_DAEMON_KIND, ROUTEKIT_PRODUCT } from "./daemon-bootstrap.js";
export type { DaemonPublicRecord, RevisionState } from "./daemon-state.js";
export {
  daemonPublicRecordPath,
  readDaemonRevisions,
  removeDaemonPublicRecord,
  writeDaemonPublicRecord,
  writeDaemonRevisions
} from "./daemon-state.js";
export { ROUTEKIT_DAEMON_WORKER_ENV } from "./host-protocol.js";

export async function startRouteKitDaemon(
  options: RouteKitDaemonOptions
): Promise<RunningRouteKitDaemon> {
  return await bootstrapRouteKitDaemon(options);
}

export async function startRouteKitDaemonHost(
  options: RouteKitDaemonOptions & { entryPath: string }
): Promise<import("./host.js").RunningRouteKitDaemonHost> {
  const daemonHost = await import("./host.js");
  return await daemonHost.startRouteKitDaemonHost(options);
}

export async function runRouteKitDaemonWorker(options: RouteKitDaemonOptions): Promise<never> {
  const daemonWorker = await import("./worker.js");
  return await daemonWorker.runRouteKitDaemonWorker(options);
}
