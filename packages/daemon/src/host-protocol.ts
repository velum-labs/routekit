import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";

export const DAEMON_HOST_PROTOCOL_VERSION = 1;
export const ROUTEKIT_DAEMON_WORKER_ENV = "ROUTEKIT_DAEMON_WORKER";
export const ROUTEKIT_DAEMON_GENERATION_ENV = "ROUTEKIT_DAEMON_GENERATION";
export const ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV = "ROUTEKIT_DAEMON_CONTROL_TOKEN";
export const ROUTEKIT_DAEMON_DATA_URL_ENV = "ROUTEKIT_DAEMON_DATA_URL";
export const ROUTEKIT_DAEMON_DATA_PORT_ENV = "ROUTEKIT_DAEMON_DATA_PORT";
export const ROUTEKIT_DAEMON_CONTROL_PORT_ENV = "ROUTEKIT_DAEMON_CONTROL_PORT";
export const ROUTEKIT_DAEMON_HOST_PID_ENV = "ROUTEKIT_DAEMON_HOST_PID";
export const ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV = "ROUTEKIT_DAEMON_HOST_STARTED_AT";
export const ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV = "ROUTEKIT_DAEMON_INITIAL_PAUSED";

export type WorkerSnapshot = {
  generation: number;
  configRevision: number;
  accountRevision: number;
  configHash: string;
};

export type WorkerReady = WorkerSnapshot & {
  type: "worker.ready";
  protocolVersion: number;
  workerPid: number;
  workerProcessIdentity?: string;
  workerStartedAt: string;
  packageVersion: string;
  controlUrl: string;
  controlPort: number;
  dataUrl: string;
  dataPort: number;
  binPath?: string;
};

export type WorkerRequest =
  | { type: "worker.pause"; requestId: string }
  | { type: "worker.resume"; requestId: string }
  | { type: "worker.retire"; requestId: string; graceMs: number }
  | { type: "worker.shutdown"; requestId: string }
  | {
      type: "worker.hostState";
      requestId: string;
      dataUrl: string;
      hostPid: number;
      hostStartedAt: string;
      rolling: boolean;
    };

export type WorkerResponse =
  | { type: "worker.response"; requestId: string; ok: true; result?: unknown }
  | { type: "worker.response"; requestId: string; ok: false; error: string };

export type WorkerToHostRequest =
  | {
      type: "host.roll";
      requestId: string;
      params: RouteKitControlParams["daemon.roll"];
    }
  | {
      type: "host.shutdown";
      reason: "stop" | "restart" | "upgrade";
    }
  | {
      type: "host.sidecar";
      requestId: string;
      operation: "reconcile" | "refresh" | "reachable" | "status";
      wanted?: boolean;
      timeoutMs?: number;
    };

export type HostToWorkerResponse =
  | {
      type: "host.response";
      requestId: string;
      ok: true;
      result?: RouteKitControlResults["daemon.roll"] | unknown;
    }
  | { type: "host.response"; requestId: string; ok: false; error: string };

export type HostWorkerMessage =
  | WorkerReady
  | WorkerRequest
  | WorkerResponse
  | WorkerToHostRequest
  | HostToWorkerResponse;
