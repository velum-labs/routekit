import type { Worker } from "node:cluster";
import cluster from "node:cluster";

import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Deferred, Effect, Exit } from "effect";

import {
  DAEMON_HOST_PROTOCOL_VERSION,
  type HostToWorkerResponse,
  type HostWorkerMessage,
  ROUTEKIT_DAEMON_CONTROL_PORT_ENV,
  ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV,
  ROUTEKIT_DAEMON_DATA_PORT_ENV,
  ROUTEKIT_DAEMON_DATA_URL_ENV,
  ROUTEKIT_DAEMON_GENERATION_ENV,
  ROUTEKIT_DAEMON_HOST_PID_ENV,
  ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV,
  ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV,
  ROUTEKIT_DAEMON_WORKER_ENV,
  type WorkerReady,
  type WorkerRequest,
  type WorkerRequestInput
} from "./host-protocol.js";
import { RequestReplyChannel } from "./ipc-request-channel.js";

const WORKER_READY_TIMEOUT_MS = 90_000;
const WORKER_REQUEST_TIMEOUT_MS = 120_000;
export const RETIRE_FORCE_EXTRA_MS = 10_000;

type WorkerChannel = RequestReplyChannel<
  WorkerRequestInput,
  WorkerRequest,
  Extract<HostWorkerMessage, { type: "worker.response" }>
>;

type ReadyWaiter = Deferred.Deferred<WorkerReady, Error>;

export type HostWorkerSpawnEnv = {
  env: NodeJS.ProcessEnv;
  controlToken: string;
  controlPort: number;
  dataPort: number;
  dataUrl: () => string;
  hostStartedAt: string;
  drainGraceMs: number;
};

export type HostWorkerSpawnInput = {
  binPath: string;
  generation: number;
  initiallyPaused: boolean;
  expectedVersion: string;
};

/**
 * One cluster worker and the host's request/reply channel to it.
 * The daemon host owns singleton authority, ports, and rolls; this session
 * only talks to the worker.
 */
export class HostWorkerSession {
  readonly worker: Worker;
  readonly ready: WorkerReady;
  readonly binPath: string;
  readonly #channel: WorkerChannel;
  readonly #drainGraceMs: number;

  constructor(input: {
    worker: Worker;
    ready: WorkerReady;
    binPath: string;
    channel: WorkerChannel;
    drainGraceMs: number;
  }) {
    this.worker = input.worker;
    this.ready = input.ready;
    this.binPath = input.binPath;
    this.#channel = input.channel;
    this.#drainGraceMs = input.drainGraceMs;
  }

  get id(): number {
    return this.worker.id;
  }

  async request<T>(input: WorkerRequestInput): Promise<T> {
    return await this.#channel.request<T>(input);
  }

  requestEffect<T>(input: WorkerRequestInput): Effect.Effect<T, Error> {
    return Effect.tryPromise({
      try: () => this.request<T>(input),
      catch: toRouteKitFailure
    });
  }

  shutdown(): Effect.Effect<void, Error> {
    return shutdownWorker(this.worker, this.#channel);
  }

  retire(): Effect.Effect<void> {
    const self = this;
    const worker = this.worker;
    return Effect.gen(function* () {
      yield* self.requestEffect({
        type: "worker.retire",
        graceMs: self.#drainGraceMs
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (!worker.isDead()) worker.process.kill("SIGTERM");
          })
        )
      );
      yield* Effect.sleep(`${self.#drainGraceMs + RETIRE_FORCE_EXTRA_MS} millis`);
      if (!worker.isDead()) worker.process.kill("SIGKILL");
    });
  }
}

export function sendHostResponse(worker: Worker, response: HostToWorkerResponse): void {
  if (worker.isConnected()) worker.send(response);
}

function createChannel(worker: Worker): WorkerChannel {
  return new RequestReplyChannel<
    WorkerRequestInput,
    WorkerRequest,
    Extract<HostWorkerMessage, { type: "worker.response" }>
  >({
    idPrefix: `host-${worker.id}`,
    timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    encode: (request, requestId) => ({ ...request, requestId }) as WorkerRequest,
    send: (message) => worker.send(message),
    requestId: (response) => response.requestId,
    decode: (response) =>
      response.ok
        ? { ok: true, value: response.result }
        : { ok: false, error: new Error(response.error) }
  });
}

function shutdownWorker(worker: Worker, channel: WorkerChannel): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (worker.isDead()) return;
    yield* Effect.tryPromise({
      try: () => channel.request({ type: "worker.shutdown" }),
      catch: toRouteKitFailure
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          worker.process.kill("SIGTERM");
        })
      )
    );
  });
}

/**
 * Spawns workers and routes their ready/response IPC. Host-directed messages
 * (`host.roll`, sidecar, idempotency, shutdown) stay on the daemon host.
 */
export class HostWorkerCoordinator {
  readonly #spawnEnv: HostWorkerSpawnEnv;
  readonly #channels = new Map<number, WorkerChannel>();
  readonly #readyWaiters = new Map<number, ReadyWaiter>();

  constructor(spawnEnv: HostWorkerSpawnEnv) {
    this.#spawnEnv = spawnEnv;
  }

  spawn(input: HostWorkerSpawnInput): Effect.Effect<HostWorkerSession, Error> {
    const self = this;
    return Effect.gen(function* () {
      const { env, controlToken, controlPort, dataPort, dataUrl, hostStartedAt, drainGraceMs } =
        self.#spawnEnv;
      cluster.setupPrimary({ exec: input.binPath, args: process.argv.slice(2), silent: false });
      const worker = cluster.fork({
        ...env,
        [ROUTEKIT_DAEMON_WORKER_ENV]: "1",
        [ROUTEKIT_DAEMON_GENERATION_ENV]: String(input.generation),
        [ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV]: controlToken,
        [ROUTEKIT_DAEMON_CONTROL_PORT_ENV]: String(controlPort),
        [ROUTEKIT_DAEMON_DATA_PORT_ENV]: String(dataPort),
        [ROUTEKIT_DAEMON_DATA_URL_ENV]: dataUrl(),
        [ROUTEKIT_DAEMON_HOST_PID_ENV]: String(process.pid),
        [ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV]: hostStartedAt,
        [ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV]: input.initiallyPaused ? "1" : "0"
      });
      const channel = createChannel(worker);
      self.#channels.set(worker.id, channel);
      const readyWaiter = Deferred.makeUnsafe<WorkerReady, Error>();
      self.#readyWaiters.set(worker.id, readyWaiter);
      worker.once("exit", (code, signal) => {
        const waiter = self.#readyWaiters.get(worker.id);
        if (waiter === undefined) return;
        self.#readyWaiters.delete(worker.id);
        Deferred.doneUnsafe(
          waiter,
          Exit.fail(
            new RouteKitFailure({
              message: `daemon worker exited before readiness (${signal ?? `code ${code ?? "unknown"}`})`
            })
          )
        );
      });
      const ready = yield* Deferred.await(readyWaiter).pipe(
        Effect.timeoutOrElse({
          duration: `${WORKER_READY_TIMEOUT_MS} millis`,
          orElse: () =>
            Effect.fail(
              new RouteKitFailure({
                message: `daemon worker ${worker.process.pid ?? worker.id} did not become ready`
              })
            )
        }),
        Effect.ensuring(
          Effect.sync(() => {
            self.#readyWaiters.delete(worker.id);
          })
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            channel.close(new Error("daemon worker failed during readiness"));
            self.#channels.delete(worker.id);
            if (!worker.isDead()) worker.process.kill("SIGTERM");
          })
        )
      );
      if (ready.protocolVersion !== DAEMON_HOST_PROTOCOL_VERSION) {
        yield* shutdownWorker(worker, channel);
        self.#channels.delete(worker.id);
        return yield* new RouteKitFailure({
          message: `daemon worker host protocol ${ready.protocolVersion} is incompatible with ${DAEMON_HOST_PROTOCOL_VERSION}`
        });
      }
      if (ready.packageVersion !== input.expectedVersion) {
        yield* shutdownWorker(worker, channel);
        self.#channels.delete(worker.id);
        return yield* new RouteKitFailure({
          message: `daemon worker version ${ready.packageVersion} did not match expected ${input.expectedVersion}`
        });
      }
      return new HostWorkerSession({
        worker,
        ready,
        binPath: input.binPath,
        channel,
        drainGraceMs
      });
    });
  }

  /** True when the message is worker ready/response IPC owned by this coordinator. */
  accept(worker: Worker, message: HostWorkerMessage): boolean {
    if (message.type === "worker.ready") {
      const waiter = this.#readyWaiters.get(worker.id);
      if (waiter === undefined) return true;
      this.#readyWaiters.delete(worker.id);
      Deferred.doneUnsafe(waiter, Exit.succeed(message));
      return true;
    }
    if (message.type === "worker.response") {
      this.#channels.get(worker.id)?.accept(message);
      return true;
    }
    return false;
  }

  drop(worker: Worker, reason = new Error("daemon worker exited")): void {
    this.#channels.get(worker.id)?.close(reason);
    this.#channels.delete(worker.id);
  }

  shutdownAll(workers: Worker[]): Effect.Effect<void, Error> {
    const self = this;
    return Effect.forEach(
      workers,
      (worker) => {
        const channel = self.#channels.get(worker.id);
        if (channel === undefined) {
          return Effect.sync(() => {
            if (!worker.isDead()) worker.process.kill("SIGTERM");
          });
        }
        return shutdownWorker(worker, channel).pipe(Effect.ignore);
      },
      { concurrency: "unbounded" }
    ).pipe(Effect.asVoid);
  }
}
