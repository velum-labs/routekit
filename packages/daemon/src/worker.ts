import cluster from "node:cluster";
import { createHash } from "node:crypto";

import type {
  RouteKitControlMethod,
  RouteKitControlParams,
  RouteKitControlResults
} from "@velum-labs/routekit-control";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Ref } from "effect";

import { daemonLive } from "./effect/daemon-live.js";
import type { RouteKitDaemonOptions } from "./daemon-options.js";
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
import { DaemonRuntime, type DaemonRuntimeValue } from "./services/daemon-runtime/service.js";
import { WorkerIpc, type WorkerIpcValue } from "./services/worker-ipc/service.js";

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing hosted worker environment ${name}`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid hosted worker ${name}`);
  }
  return parsed;
}

function send(message: HostWorkerMessage): void {
  if (typeof process.send !== "function") {
    throw new Error("hosted daemon worker has no IPC channel");
  }
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
  const hostState = Ref.makeUnsafe({
    dataUrl: requiredEnv(env, ROUTEKIT_DAEMON_DATA_URL_ENV),
    rolling: env[ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV] === "1"
  });

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

  const daemonOptions: RouteKitDaemonOptions = {
    ...options,
    port: dataPort,
    controlPort,
    hosted: {
      generation,
      controlToken,
      dataUrl: () => Ref.getUnsafe(hostState).dataUrl,
      hostPid,
      hostStartedAt,
      rolling: () => Ref.getUnsafe(hostState).rolling,
      sidecarRequest: requestHost,
      initiallyPaused: env[ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV] === "1",
      executeIdempotent
    },
    onRollRequested,
    onShutdownRequested: (reason) => send({ type: "host.shutdown", reason })
  };
  const ipc = WorkerIpc.layer((message) => hostRequests.accept(message));
  const application = Layer.unwrap(
    Effect.map(WorkerIpc, () => daemonLive(daemonOptions))
  ).pipe(Layer.provideMerge(ipc));
  const runtime = ManagedRuntime.make(application);

  const runWorker = (daemon: DaemonRuntimeValue, workerIpc: WorkerIpcValue) =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* daemon.snapshot;
        send({
          type: "worker.ready",
          protocolVersion: DAEMON_HOST_PROTOCOL_VERSION,
          workerPid: process.pid,
          ...(daemon.record.processIdentity === undefined
            ? {}
            : { workerProcessIdentity: daemon.record.processIdentity }),
          workerStartedAt: daemon.record.startedAt,
          packageVersion: options.packageVersion,
          generation,
          configRevision: snapshot.configRevision,
          accountRevision: snapshot.accountRevision,
          configHash: snapshot.configHash,
          controlUrl: daemon.controlUrl,
          controlPort: daemon.record.port,
          dataUrl: daemon.dataUrl,
          dataPort: daemon.record.dataPort ?? 0,
          ...(process.argv[1] === undefined ? {} : { binPath: process.argv[1] })
        });

        const handleRequest = Effect.fn("DaemonWorker.handleRequest")(function* (
          request: WorkerRequest
        ) {
          const result = yield* Effect.gen(function* () {
            switch (request.type) {
              case "worker.pause":
                return yield* daemon.pauseMutations;
              case "worker.resume":
                yield* daemon.resumeMutations;
                yield* Ref.update(hostState, (state) => ({ ...state, rolling: false }));
                return undefined;
              case "worker.hostState":
                yield* Ref.set(hostState, {
                  dataUrl: request.dataUrl,
                  rolling: request.rolling
                });
                return undefined;
              case "worker.retire":
                yield* daemon.prepareRetire(request.graceMs);
                return { retired: true };
              case "worker.shutdown":
                yield* daemon.prepareClose;
                return { closed: true };
            }
          });
          send({
            type: "worker.response",
            requestId: request.requestId,
            ok: true,
            result
          } satisfies WorkerResponse);
          if (request.type === "worker.retire" || request.type === "worker.shutdown") {
            yield* Deferred.succeed(workerIpc.finished, undefined);
          }
        });

        yield* Effect.forever(
          Queue.take(workerIpc.events).pipe(
            Effect.flatMap((event) =>
              event.type === "disconnect"
                ? Effect.gen(function* () {
                    const error = new ControlError({
                      code: "unavailable",
                      message: "daemon host disconnected"
                    });
                    hostRequests.close(error);
                    yield* daemon.prepareClose.pipe(Effect.ignore);
                    yield* Deferred.fail(workerIpc.finished, error);
                  })
                : handleRequest(event.request).pipe(
                    Effect.catch((error) =>
                      Effect.sync(() =>
                        send({
                          type: "worker.response",
                          requestId: event.request.requestId,
                          ok: false,
                          error: error instanceof Error ? error.message : String(error)
                        } satisfies WorkerResponse)
                      )
                    )
                  )
            )
          )
        ).pipe(Effect.forkScoped);

        yield* Deferred.await(workerIpc.finished);
      })
    );

  let exitCode = 0;
  try {
    const [daemon, workerIpc] = await runtime.runPromise(
      Effect.all([DaemonRuntime, WorkerIpc])
    );
    await runtime.runPromise(runWorker(daemon, workerIpc));
  } catch (error) {
    exitCode = 1;
    if (process.connected) process.disconnect();
    throw error;
  } finally {
    hostRequests.close(new Error("daemon worker stopped"));
    await runtime.dispose();
  }
  process.exit(exitCode);
}
