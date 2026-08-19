import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Worker } from "node:cluster";
import cluster from "node:cluster";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  type ControlErrorCode,
  generateControlToken
} from "@velum-labs/routekit-runtime/control";
import {
  executeWebRequest,
  RouteKitFailure,
  RouteKitLive,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { extendCleanupGrace, registerCleanup } from "@velum-labs/routekit-runtime/lifecycle";
import { createPortlessSession, gatewayPath } from "@velum-labs/routekit-runtime/network";
import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import {
  acquireLifecycleLock,
  createServiceRecordStore,
  nextServiceGeneration,
  processIdentity,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime/service";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Queue,
  Ref,
  Scope,
  Semaphore
} from "effect";
import { HttpClient } from "effect/unstable/http";

import { createCliproxySidecar } from "./cliproxy-sidecar.js";
import {
  ROUTEKIT_DAEMON_KIND,
  ROUTEKIT_PRODUCT,
  type RouteKitDaemonOptions
} from "./daemon-bootstrap.js";
import {
  readDaemonRevisions,
  removeDaemonPublicRecord,
  writeDaemonPublicRecord,
  writeDaemonRevisions
} from "./daemon-state.js";
import { runHostGenerationTransactionEffect } from "./host-generation-transaction.js";
import { HostIdempotencyCoordinator } from "./host-idempotency.js";
import {
  DAEMON_HOST_PROTOCOL_VERSION,
  type HostWorkerMessage,
  type WorkerToHostRequest
} from "./host-protocol.js";
import {
  HostWorkerCoordinator,
  type HostWorkerSession,
  RETIRE_FORCE_EXTRA_MS,
  sendHostResponse
} from "./host-worker-session.js";

export type RunningRouteKitDaemonHost = {
  record: ServiceRecord;
  dataUrl: string;
  controlUrl: string;
  close(): Promise<void>;
};

type HostOptions = RouteKitDaemonOptions & { entryPath: string };

type OwnedWorker = {
  readonly session: HostWorkerSession;
  readonly scope: Scope.Closeable;
};

type HostPublication = {
  readonly generation: number;
  readonly active?: OwnedWorker;
  readonly fallback?: OwnedWorker;
  readonly record?: ServiceRecord;
};

type HostEvent =
  | { readonly type: "message"; readonly worker: Worker; readonly message: HostWorkerMessage }
  | {
      readonly type: "exit";
      readonly worker: Worker;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

type DaemonHostApplicationValue = {
  readonly record: ServiceRecord;
  readonly dataUrl: string;
  readonly controlUrl: string;
  readonly shutdownRequested: Deferred.Deferred<void>;
};

class DaemonHostApplication extends Context.Service<
  DaemonHostApplication,
  DaemonHostApplicationValue
>()("@velum-labs/routekit-daemon/DaemonHostApplication") {}

function reservePort(host: string): Effect.Effect<number, Error> {
  return Effect.tryPromise({
    try: async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => resolve());
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (port <= 0) throw new Error("failed to reserve daemon port");
      return port;
    },
    catch: toRouteKitFailure
  });
}

function loopbackUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function candidateVersion(binPath: string): string | undefined {
  const result = spawnSync(process.execPath, [binPath, "--version"], {
    encoding: "utf8",
    timeout: 10_000
  });
  if (result.status !== 0) return undefined;
  return result.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/)?.[1];
}

const requestWorker = <A>(session: HostWorkerSession, input: Parameters<HostWorkerSession["request"]>[0]) =>
  session.requestEffect<A>(input);

function daemonHostLive(options: HostOptions): Layer.Layer<DaemonHostApplication, Error> {
  const acquire = Effect.gen(function* () {
    if (!cluster.isPrimary) {
      return yield* new RouteKitFailure({ message: "daemon host must run as the cluster primary" });
    }

    const parentScope = yield* Scope.Scope;
    const env = options.env ?? process.env;
    const home = options.stateHome ?? routekitHome(env);
    const host = options.host ?? "127.0.0.1";
    const dataPort =
      options.port === undefined || options.port === 0 ? yield* reservePort(host) : options.port;
    const controlPort = yield* reservePort("127.0.0.1");
    const drainGraceMs = options.drainGraceMs ?? 30_000;
    const hostStartedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const controlToken = generateControlToken();
    const store = createServiceRecordStore({ home, product: ROUTEKIT_PRODUCT });
    const authority = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => acquireLifecycleLock(join(store.directory, "daemon-authority.lock")),
        catch: toRouteKitFailure
      }),
      (lock) => Effect.sync(() => lock.release())
    );
    void authority;

    const revisions = readDaemonRevisions(home);
    const previous = store.read(ROUTEKIT_DAEMON_KIND);
    const generation = nextServiceGeneration(Math.max(previous?.generation ?? 0, revisions.daemon));
    revisions.daemon = generation;
    writeDaemonRevisions(home, revisions);

    const portless = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createPortlessSession(options.portless ?? env.ROUTEKIT_PORTLESS !== "0", {
            project: ROUTEKIT_PRODUCT,
            ownerLabel: "routekit-daemon",
            bareNames: []
          }),
        catch: toRouteKitFailure
      }),
      (session) =>
        Effect.sync(() => {
          if (session.enabled) session.unregister("gateway");
        })
    );
    const dataUrl = portless.enabled
      ? portless.register("gateway", dataPort)
      : loopbackUrl(host, dataPort);

    const sidecar = yield* Effect.acquireRelease(
      Effect.sync(() => createCliproxySidecar({ env })),
      (owned) => owned.close.pipe(Effect.ignore)
    );
    const sidecarGate = yield* Semaphore.make(1);
    const transitionGate = yield* Semaphore.make(1);
    const publication = yield* Ref.make<HostPublication>({ generation });
    const shutdownRequested = yield* Deferred.make<void>();
    const idempotency = new HostIdempotencyCoordinator();
    const workers = new HostWorkerCoordinator({
      env,
      controlToken,
      controlPort,
      dataPort,
      dataUrl: () => dataUrl,
      hostStartedAt,
      drainGraceMs
    });

    const hostState = (rolling: boolean) => ({
      type: "worker.hostState" as const,
      dataUrl,
      hostPid: process.pid,
      hostStartedAt,
      rolling
    });

    const writeRecord = (managed: HostWorkerSession): ServiceRecord => {
      const ready = managed.ready;
      const identity = processIdentity(process.pid);
      const record = store.write({
        kind: ROUTEKIT_DAEMON_KIND,
        pid: process.pid,
        ...(identity === undefined ? {} : { processIdentity: identity }),
        workerPid: ready.workerPid,
        ...(ready.workerProcessIdentity === undefined
          ? {}
          : { workerProcessIdentity: ready.workerProcessIdentity }),
        workerStartedAt: ready.workerStartedAt,
        hostProtocolVersion: DAEMON_HOST_PROTOCOL_VERSION,
        url: loopbackUrl("127.0.0.1", controlPort),
        port: controlPort,
        startedAt: hostStartedAt,
        version: ready.packageVersion,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        controlToken,
        dataUrl,
        dataPort,
        host,
        portless: portless.enabled,
        drainGraceMs,
        authTokenFile: options.authTokenFile ?? join(home, "secrets", "data-token"),
        generation: ready.generation,
        supervisor: supervisorFromEnv(env),
        binPath: managed.binPath,
        args: process.argv.slice(2),
        cwd: process.cwd()
      });
      writeDaemonPublicRecord(home, {
        product: ROUTEKIT_PRODUCT,
        kind: ROUTEKIT_DAEMON_KIND,
        url: record.url,
        port: controlPort,
        generation: ready.generation,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        dataUrl,
        dataPort,
        startedAt: hostStartedAt
      });
      return record;
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
        removeDaemonPublicRecord(home);
      })
    );

    const spawnOwned = Effect.fn("DaemonHost.spawnWorker")(function* (input: {
      binPath: string;
      generation: number;
      initiallyPaused: boolean;
      expectedVersion: string;
    }) {
      const scope = yield* Scope.fork(parentScope, "sequential");
      const opened = yield* Effect.exit(
        Scope.provide(scope)(
          Effect.acquireRelease(workers.spawn(input), (session) =>
            session.shutdown().pipe(Effect.ignore)
          )
        )
      );
      if (Exit.isFailure(opened)) {
        yield* Scope.close(scope, opened);
        return yield* Effect.failCause(opened.cause);
      }
      return { session: opened.value, scope } satisfies OwnedWorker;
    });

    const closeOwned = (owned: OwnedWorker) => Scope.close(owned.scope, Exit.void).pipe(Effect.ignore);

    const verifySharedGateway = Effect.gen(function* () {
      const tokenPath = options.authTokenFile ?? join(home, "secrets", "data-token");
      const token = yield* Effect.try({
        try: () => readFileSync(tokenPath, "utf8").trim(),
        catch: toRouteKitFailure
      });
      const health = yield* executeWebRequest(`${dataUrl}/health`).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError(toRouteKitFailure)
      );
      if (!health.ok) {
        return yield* new RouteKitFailure({
          message: `candidate gateway health failed (${health.status})`
        });
      }
      const models = yield* executeWebRequest(gatewayPath(dataUrl, "/v1/models"), {
        headers: { authorization: `Bearer ${token}` }
      }).pipe(Effect.timeout("15 seconds"), Effect.mapError(toRouteKitFailure));
      if (!models.ok) {
        return yield* new RouteKitFailure({
          message: `candidate model readiness failed (${models.status})`
        });
      }
    });

    const retireFallback = (owned: OwnedWorker) =>
      Effect.gen(function* () {
        yield* Effect.sleep("250 millis");
        const current = yield* Ref.get(publication);
        if (current.fallback?.session.id !== owned.session.id) return;
        yield* Ref.set(publication, { ...current, fallback: undefined });
        yield* owned.session.retire();
        yield* closeOwned(owned);
      });

    const roll = Effect.fn("DaemonHost.roll")(function* (
      params: RouteKitControlParams["daemon.roll"]
    ) {
      const current = yield* Ref.get(publication);
      const previousActive = current.active;
      if (previousActive === undefined) {
        return yield* new RouteKitFailure({ message: "RouteKit daemon has no active worker" });
      }
      if (params.expectedGeneration !== previousActive.session.ready.generation) {
        return yield* new RouteKitFailure({
          message: `daemon generation conflict: expected ${params.expectedGeneration}, current ${previousActive.session.ready.generation}`
        });
      }
      const binPath = params.candidate?.binPath ?? previousActive.session.binPath;
      const expectedVersion =
        params.candidate?.expectedVersion ?? previousActive.session.ready.packageVersion;
      yield* Effect.logInfo("routekit daemon roll requested").pipe(
        Effect.annotateLogs({
          reason: params.reason,
          generation: previousActive.session.ready.generation,
          fromVersion: previousActive.session.ready.packageVersion,
          toVersion: expectedVersion
        })
      );
      if (!isAbsolute(binPath)) {
        return yield* new RouteKitFailure({
          message: "daemon roll candidate path must be absolute"
        });
      }
      const probed = yield* Effect.sync(() => candidateVersion(binPath));
      if (probed !== expectedVersion) {
        return yield* new RouteKitFailure({
          message: `daemon roll candidate reported ${probed ?? "no version"}; expected ${expectedVersion}`
        });
      }
      yield* requestWorker(previousActive.session, hostState(true));
      const stable = yield* requestWorker<{
        configRevision: number;
        accountRevision: number;
        configHash: string;
      }>(previousActive.session, { type: "worker.pause" });
      const nextGeneration = nextServiceGeneration(previousActive.session.ready.generation);

      return yield* runHostGenerationTransactionEffect({
        prepare: () =>
          spawnOwned({
            binPath,
            generation: nextGeneration,
            initiallyPaused: true,
            expectedVersion
          }),
        validate: (candidate) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("routekit daemon candidate prepared").pipe(
              Effect.annotateLogs({
                generation: candidate.session.ready.generation,
                workerPid: candidate.session.ready.workerPid,
                version: candidate.session.ready.packageVersion
              })
            );
            if (
              candidate.session.ready.configRevision !== stable.configRevision ||
              candidate.session.ready.accountRevision !== stable.accountRevision ||
              candidate.session.ready.configHash !== stable.configHash
            ) {
              return yield* new RouteKitFailure({
                message: "candidate state changed while synchronizing; retry the daemon roll"
              });
            }
            yield* verifySharedGateway;
          }),
        persist: (candidate) =>
          Effect.gen(function* () {
            yield* requestWorker(candidate.session, hostState(false));
            yield* requestWorker(candidate.session, { type: "worker.resume" });
            revisions.daemon = nextGeneration;
            writeDaemonRevisions(home, revisions);
          }),
        commit: (candidate) =>
          Effect.gen(function* () {
            const record = writeRecord(candidate.session);
            yield* Ref.set(publication, {
              generation: nextGeneration,
              active: candidate,
              fallback: previousActive,
              record
            });
            yield* Effect.logInfo("routekit daemon worker generation committed").pipe(
              Effect.annotateLogs({
                generation: nextGeneration,
                workerPid: candidate.session.ready.workerPid
              })
            );
            return {
              rolled: true,
              reason: params.reason,
              previousGeneration: previousActive.session.ready.generation,
              generation: nextGeneration,
              previousWorkerPid: previousActive.session.ready.workerPid,
              workerPid: candidate.session.ready.workerPid,
              packageVersion: candidate.session.ready.packageVersion
            };
          }),
        rollback: (candidate, error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("routekit daemon roll rolled back").pipe(
              Effect.annotateLogs({
                reason: params.reason,
                stage: candidate === undefined ? "preparation" : "activation",
                error: error instanceof Error ? error.message : String(error)
              })
            );
            if (candidate !== undefined) yield* closeOwned(candidate);
            revisions.daemon = previousActive.session.ready.generation;
            writeDaemonRevisions(home, revisions);
            const record = writeRecord(previousActive.session);
            yield* Ref.set(publication, {
              generation: previousActive.session.ready.generation,
              active: previousActive,
              record
            });
            yield* requestWorker(previousActive.session, { type: "worker.resume" });
            yield* requestWorker(previousActive.session, hostState(false));
          }),
        retire: () => retireFallback(previousActive).pipe(Effect.forkIn(parentScope), Effect.asVoid)
      });
    });

    const recoverActiveWorker = Effect.fn("DaemonHost.recoverWorker")(function* (
      worker: Worker
    ) {
      idempotency.failOwner(worker.id);
      workers.drop(worker);
      const current = yield* Ref.get(publication);
      if (current.active?.session.id !== worker.id) return;
      const failed = current.active;
      const fallback = current.fallback;
      if (fallback !== undefined && !fallback.session.worker.isDead()) {
        revisions.daemon = fallback.session.ready.generation;
        writeDaemonRevisions(home, revisions);
        const record = writeRecord(fallback.session);
        yield* Ref.set(publication, {
          generation: fallback.session.ready.generation,
          active: fallback,
          record
        });
        yield* requestWorker(fallback.session, hostState(false));
        yield* requestWorker(fallback.session, { type: "worker.resume" });
        yield* closeOwned(failed);
        yield* Effect.logWarning("routekit daemon restored previous worker after active exit").pipe(
          Effect.annotateLogs({
            generation: fallback.session.ready.generation,
            workerPid: fallback.session.ready.workerPid
          })
        );
        return;
      }

      yield* Effect.logWarning("routekit daemon active worker exited; respawning").pipe(
        Effect.annotateLogs({
          generation: failed.session.ready.generation,
          workerPid: failed.session.ready.workerPid
        })
      );
      const replacement = yield* spawnOwned({
        binPath: failed.session.binPath,
        generation: failed.session.ready.generation,
        initiallyPaused: false,
        expectedVersion: failed.session.ready.packageVersion
      });
      yield* requestWorker(replacement.session, hostState(false));
      const record = writeRecord(replacement.session);
      yield* Ref.set(publication, {
        generation: replacement.session.ready.generation,
        active: replacement,
        record
      });
      yield* closeOwned(failed);
      if (fallback !== undefined) yield* closeOwned(fallback);
      yield* Effect.logInfo("routekit daemon committed worker respawned").pipe(
        Effect.annotateLogs({
          generation: replacement.session.ready.generation,
          workerPid: replacement.session.ready.workerPid
        })
      );
    });

    const sidecarOperation = (
      request: Extract<WorkerToHostRequest, { type: "host.sidecar" }>
    ) =>
      sidecarGate.withPermit(
        Effect.gen(function* () {
          switch (request.operation) {
            case "reconcile":
              yield* sidecar.reconcile(request.wanted === true);
              return { managed: sidecar.managed(), running: sidecar.running() };
            case "refresh":
              yield* sidecar.refresh;
              return { managed: sidecar.managed(), running: sidecar.running() };
            case "reachable":
              return yield* sidecar.reachable(request.timeoutMs);
            case "status":
              return { managed: sidecar.managed(), running: sidecar.running() };
          }
        })
      );

    const sendResult = <A, R>(
      worker: Worker,
      requestId: string,
      effect: Effect.Effect<A, unknown, R>,
      code?: (error: unknown) => ControlErrorCode | undefined
    ) =>
      Effect.matchEffect(effect, {
        onSuccess: (result) =>
          Effect.sync(() =>
            sendHostResponse(worker, {
              type: "host.response",
              requestId,
              ok: true,
              result
            })
          ),
        onFailure: (error) =>
          Effect.sync(() =>
            sendHostResponse(worker, {
              type: "host.response",
              requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...(code?.(error) === undefined ? {} : { code: code(error) })
            })
          )
      });

    const handleMessage = Effect.fn("DaemonHost.handleMessage")(function* (
      worker: Worker,
      message: HostWorkerMessage
    ) {
      switch (message.type) {
        case "host.sidecar":
          yield* sendResult(worker, message.requestId, sidecarOperation(message));
          return;
        case "host.idempotency.begin":
          yield* sendResult(
            worker,
            message.requestId,
            Effect.tryPromise({
              try: () =>
                idempotency.begin(message.method, message.key, message.fingerprint, worker.id),
              catch: toRouteKitFailure
            }),
            (error) =>
              error instanceof RouteKitFailure && error.cause instanceof ControlError
                ? error.cause.code
                : undefined
          );
          return;
        case "host.idempotency.complete":
          yield* sendResult(
            worker,
            message.requestId,
            Effect.try({
              try: () => idempotency.complete(message.operationId, message.result),
              catch: toRouteKitFailure
            })
          );
          return;
        case "host.idempotency.fail":
          yield* sendResult(
            worker,
            message.requestId,
            Effect.try({
              try: () => idempotency.fail(message.operationId),
              catch: toRouteKitFailure
            })
          );
          return;
        case "host.roll": {
          const current = yield* Ref.get(publication);
          if (current.active?.session.id !== worker.id) {
            yield* sendResult(
              worker,
              message.requestId,
              Effect.fail(
                new RouteKitFailure({
                  message: "only the active daemon worker may request a roll"
                })
              )
            );
            return;
          }
          yield* sendResult(worker, message.requestId, transitionGate.withPermit(roll(message.params)));
          return;
        }
        case "host.shutdown":
          yield* Deferred.succeed(shutdownRequested, undefined);
          return;
        default:
          return;
      }
    });

    const events = yield* Queue.unbounded<HostEvent>();
    const onMessage = (worker: Worker, message: unknown): void => {
      const hostMessage = message as HostWorkerMessage;
      if (workers.accept(worker, hostMessage)) return;
      Queue.offerUnsafe(events, { type: "message", worker, message: hostMessage });
    };
    const onExit = (worker: Worker, code: number | null, signal: NodeJS.Signals | null): void => {
      Queue.offerUnsafe(events, { type: "exit", worker, code, signal });
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        cluster.on("message", onMessage);
        cluster.on("exit", onExit);
      }),
      () =>
        Effect.sync(() => {
          cluster.off("message", onMessage);
          cluster.off("exit", onExit);
          return;
        })
        .pipe(Effect.andThen(Queue.shutdown(events)))
    );

    const supervise = (event: HostEvent): Effect.Effect<void, never, HttpClient.HttpClient> => {
      const operation: Effect.Effect<void, unknown, HttpClient.HttpClient> =
        event.type === "message"
          ? handleMessage(event.worker, event.message)
          : transitionGate.withPermit(recoverActiveWorker(event.worker));
      return operation.pipe(
        Effect.catch((error: unknown) =>
          Effect.gen(function* () {
            process.exitCode = 1;
            yield* Effect.logError("routekit daemon host supervision failed").pipe(
              Effect.annotateLogs({
                error: error instanceof Error ? error.message : String(error),
                workerPid: event.worker.process.pid ?? event.worker.id
              })
            );
            yield* Deferred.succeed(shutdownRequested, undefined);
          })
        )
      );
    };

    yield* Effect.forever(
      Queue.take(events).pipe(
        Effect.flatMap((event) => supervise(event).pipe(Effect.forkScoped, Effect.asVoid))
      )
    ).pipe(Effect.forkScoped);

    const initial = yield* spawnOwned({
      binPath: options.entryPath,
      generation,
      initiallyPaused: false,
      expectedVersion: options.packageVersion
    });
    yield* requestWorker(initial.session, hostState(false));
    const record = writeRecord(initial.session);
    yield* Ref.set(publication, { generation, active: initial, record });

    return DaemonHostApplication.of({
      record,
      dataUrl,
      controlUrl: record.url,
      shutdownRequested
    });
  });

  return Layer.effect(DaemonHostApplication, acquire).pipe(
    Layer.provide(RouteKitLive)
  ) as Layer.Layer<DaemonHostApplication, Error>;
}

export async function startRouteKitDaemonHost(
  options: HostOptions
): Promise<RunningRouteKitDaemonHost> {
  const runtime = ManagedRuntime.make(daemonHostLive(options));
  let closeRun: Promise<void> | undefined;
  let unregisterCleanup = (): void => undefined;
  const close = (): Promise<void> => {
    closeRun ??= runtime.dispose().finally(() => unregisterCleanup());
    return closeRun;
  };

  try {
    const application = await runtime.runPromise(DaemonHostApplication);
    extendCleanupGrace((options.drainGraceMs ?? 30_000) + RETIRE_FORCE_EXTRA_MS);
    unregisterCleanup = registerCleanup(close);
    void runtime
      .runPromise(Deferred.await(application.shutdownRequested))
      .then(async () => {
        await close();
        process.exit(process.exitCode ?? 0);
      });
    return {
      record: application.record,
      dataUrl: application.dataUrl,
      controlUrl: application.controlUrl,
      close
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
