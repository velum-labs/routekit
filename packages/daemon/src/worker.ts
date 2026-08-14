import cluster from "node:cluster";
import { createHash } from "node:crypto";

import type {
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults
} from "@velum-labs/routekit-control";
import { ControlError } from "@velum-labs/routekit-runtime";
import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { CliproxySidecar } from "./cliproxy-sidecar.js";
import {
  bootstrapRouteKitDaemon,
  type RouteKitDaemonOptions,
  type RunningRouteKitDaemon
} from "./daemon-bootstrap.js";
import type { HostIdempotencyBegin } from "./host-idempotency.js";
import {
  DAEMON_HOST_PROTOCOL_VERSION,
  type HostWorkerMessage,
  ROUTEKIT_DAEMON_CONTROL_PORT_ENV,
  ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV,
  ROUTEKIT_DAEMON_DATA_PORT_ENV,
  ROUTEKIT_DAEMON_DATA_URL_ENV,
  ROUTEKIT_DAEMON_GENERATION_ENV,
  ROUTEKIT_DAEMON_HOST_PID_ENV,
  ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV,
  ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV,
  type WorkerHostRequestInput,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerToHostRequest
} from "./host-protocol.js";
import { RequestReplyChannel } from "./ipc-request-channel.js";

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`missing hosted worker environment ${name}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`invalid hosted worker ${name}`);
  return parsed;
}

function send(message: HostWorkerMessage): void {
  if (typeof process.send !== "function")
    throw new Error("hosted daemon worker has no IPC channel");
  process.send(message);
}

const HOST_REQUEST_TIMEOUT_MS = 120_000;

export async function runRouteKitDaemonWorker(options: RouteKitDaemonOptions): Promise<never> {
  if (!cluster.isWorker) throw new Error("daemon worker must run as a cluster worker");
  const env = options.env ?? process.env;
  const generation = positiveInteger(
    requiredEnv(env, ROUTEKIT_DAEMON_GENERATION_ENV),
    "generation"
  );
  const hostPid = positiveInteger(requiredEnv(env, ROUTEKIT_DAEMON_HOST_PID_ENV), "host pid");
  const hostStartedAt = requiredEnv(env, ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV);
  const controlToken = requiredEnv(env, ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV);
  const dataPort = positiveInteger(requiredEnv(env, ROUTEKIT_DAEMON_DATA_PORT_ENV), "data port");
  const controlPort = positiveInteger(
    requiredEnv(env, ROUTEKIT_DAEMON_CONTROL_PORT_ENV),
    "control port"
  );
  let dataUrl = requiredEnv(env, ROUTEKIT_DAEMON_DATA_URL_ENV);
  let rolling = env[ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV] === "1";
  let sidecarState = { managed: true, running: false };
  let running: RunningRouteKitDaemon | undefined;

  const hostRequests = new RequestReplyChannel<
    WorkerHostRequestInput,
    WorkerToHostRequest,
    Extract<HostWorkerMessage, { type: "host.response" }>
  >({
    idPrefix: String(process.pid),
    timeoutMs: HOST_REQUEST_TIMEOUT_MS,
    encode: (request, requestId) => ({ ...request, requestId }) as WorkerToHostRequest,
    send,
    requestId: (response) => response.requestId,
    decode: (response) =>
      response.ok
        ? { ok: true, value: response.result }
        : {
            ok: false,
            error:
              response.code === undefined
                ? new Error(response.error)
                : new ControlError({ code: response.code, message: response.error })
          }
  });

  const requestHost = async <T>(request: WorkerHostRequestInput): Promise<T> =>
    await hostRequests.request<T>(request);

  const sidecar: CliproxySidecar = {
    reconcile: (wanted) =>
      Effect.tryPromise({
        try: async () => {
          sidecarState = await requestHost({
            type: "host.sidecar",
            operation: "reconcile",
            wanted
          });
        },
        catch: (cause) => (cause instanceof Error ? cause : routeKitError(cause))
      }),
    refresh: () =>
      Effect.tryPromise({
        try: async () => {
          sidecarState = await requestHost({ type: "host.sidecar", operation: "refresh" });
        },
        catch: (cause) => (cause instanceof Error ? cause : routeKitError(cause))
      }),
    running: () => sidecarState.running,
    managed: () => sidecarState.managed,
    reachable: (timeoutMs) =>
      Effect.tryPromise({
        try: async () => {
          const reachable = await requestHost<boolean>({
            type: "host.sidecar",
            operation: "reachable",
            timeoutMs
          });
          sidecarState = { ...sidecarState, running: reachable };
          return reachable;
        },
        catch: (cause) => (cause instanceof Error ? cause : routeKitError(cause))
      }).pipe(Effect.catch(() => Effect.succeed(false))),
    close: () => Effect.void
  };

  const onRollRequested = async (
    params: RouteKitControlParams["daemon.roll"]
  ): Promise<RouteKitControlResults["daemon.roll"]> =>
    await requestHost<RouteKitControlResults["daemon.roll"]>({ type: "host.roll", params });

  const executeIdempotent = async <T>(input: {
    method: RouteKitControlMethod;
    key: string;
    params: RouteKitControlParams[RouteKitControlMethod];
    operation(): Promise<T>;
  }): Promise<T> => {
    const fingerprint = createHash("sha256").update(JSON.stringify(input.params)).digest("hex");
    const begin = await requestHost<HostIdempotencyBegin>({
      type: "host.idempotency.begin",
      method: input.method,
      key: input.key,
      fingerprint
    });
    if (begin.state === "completed") return begin.result as T;
    try {
      const result = await input.operation();
      await requestHost({
        type: "host.idempotency.complete",
        operationId: begin.operationId,
        result
      });
      return result;
    } catch (error) {
      await requestHost({
        type: "host.idempotency.fail",
        operationId: begin.operationId
      }).catch(() => undefined);
      throw error;
    }
  };

  process.on("message", (message: HostWorkerMessage) => {
    if (message.type === "host.response") {
      hostRequests.accept(message);
      return;
    }
    if (!message.type.startsWith("worker.")) return;
    const request = message as WorkerRequest;
    void (async () => {
      try {
        let result: unknown;
        switch (request.type) {
          case "worker.pause":
            result = await running?.pauseMutations();
            break;
          case "worker.resume":
            running?.resumeMutations();
            rolling = false;
            break;
          case "worker.hostState":
            dataUrl = request.dataUrl;
            rolling = request.rolling;
            break;
          case "worker.retire":
            await running?.retire(request.graceMs);
            result = { retired: true };
            break;
          case "worker.shutdown":
            await running?.close();
            result = { closed: true };
            break;
        }
        send({
          type: "worker.response",
          requestId: request.requestId,
          ok: true,
          result
        } satisfies WorkerResponse);
        if (request.type === "worker.retire" || request.type === "worker.shutdown") {
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        send({
          type: "worker.response",
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies WorkerResponse);
      }
    })();
  });
  process.once("disconnect", () => {
    hostRequests.close(new Error("daemon host disconnected"));
    void running?.close().finally(() => process.exit(1));
  });

  try {
    running = await bootstrapRouteKitDaemon({
      ...options,
      port: dataPort,
      controlPort,
      hosted: {
        generation,
        controlToken,
        dataUrl: () => dataUrl,
        hostPid,
        hostStartedAt,
        rolling: () => rolling,
        sidecar,
        initiallyPaused: env[ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV] === "1",
        executeIdempotent
      },
      onRollRequested,
      onShutdownRequested: (reason) => send({ type: "host.shutdown", reason })
    });
  } catch (error) {
    if (process.connected) process.disconnect();
    throw error;
  }
  const snapshot = running.snapshot();
  send({
    type: "worker.ready",
    protocolVersion: DAEMON_HOST_PROTOCOL_VERSION,
    workerPid: process.pid,
    ...(running.record.processIdentity !== undefined
      ? { workerProcessIdentity: running.record.processIdentity }
      : {}),
    workerStartedAt: running.record.startedAt,
    packageVersion: options.packageVersion,
    generation,
    configRevision: snapshot.configRevision,
    accountRevision: snapshot.accountRevision,
    configHash: snapshot.configHash,
    controlUrl: running.controlUrl,
    controlPort: running.record.port,
    dataUrl: running.dataUrl,
    dataPort: running.record.dataPort ?? 0,
    ...(process.argv[1] !== undefined ? { binPath: process.argv[1] } : {})
  });
  return await new Promise<never>(() => undefined);
}
