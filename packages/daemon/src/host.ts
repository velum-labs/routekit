import { spawnSync } from "node:child_process";
import type { Worker } from "node:cluster";
import cluster from "node:cluster";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import type { PortlessSession, ServiceRecord } from "@velum-labs/routekit-runtime";
import {
  acquireLifecycleLock,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  createPortlessSession,
  createServiceRecordStore,
  extendCleanupGrace,
  gatewayPath,
  generateControlToken,
  nextServiceGeneration,
  processIdentity,
  registerCleanup,
  supervisorFromEnv
} from "@velum-labs/routekit-runtime";
import { makeRouteKitRuntime } from "@velum-labs/routekit-runtime/effect";
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

async function reservePort(host: string): Promise<number> {
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
  const match = result.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/);
  return match?.[1];
}

export async function startRouteKitDaemonHost(
  options: RouteKitDaemonOptions & { entryPath: string }
): Promise<RunningRouteKitDaemonHost> {
  if (!cluster.isPrimary) throw new Error("daemon host must run as the cluster primary");
  const env = options.env ?? process.env;
  const home = options.stateHome ?? routekitHome(env);
  const host = options.host ?? "127.0.0.1";
  const dataPort =
    options.port === undefined || options.port === 0 ? await reservePort(host) : options.port;
  const controlPort = await reservePort("127.0.0.1");
  const drainGraceMs = options.drainGraceMs ?? 30_000;
  const hostStartedAt = new Date().toISOString();
  const controlToken = generateControlToken();
  const store = createServiceRecordStore({ home, product: ROUTEKIT_PRODUCT });
  const authority = await acquireLifecycleLock(join(store.directory, "daemon-authority.lock"));
  const revisions = readDaemonRevisions(home);
  const previous = store.read(ROUTEKIT_DAEMON_KIND);
  let generation = nextServiceGeneration(Math.max(previous?.generation ?? 0, revisions.daemon));
  revisions.daemon = generation;
  writeDaemonRevisions(home, revisions);
  let dataUrl = loopbackUrl(host, dataPort);
  let active: HostWorkerSession | undefined;
  let closed = false;
  let closeRun: Promise<void> | undefined;
  let rollRun: Promise<RouteKitControlResults["daemon.roll"]> | undefined;
  const workers = new HostWorkerCoordinator({
    env,
    controlToken,
    controlPort,
    dataPort,
    dataUrl: () => dataUrl,
    hostStartedAt,
    drainGraceMs
  });
  const effectRuntime = makeRouteKitRuntime();
  const sidecar = createCliproxySidecar({ env });
  const idempotency = new HostIdempotencyCoordinator();
  let sidecarTail: Promise<unknown> = Promise.resolve();
  let portless: PortlessSession | undefined;
  let record: ServiceRecord | undefined;
  let recoveryRun: Promise<void> | undefined;
  let retirementFallback: HostWorkerSession | undefined;

  const sidecarOperation = async (
    request: Extract<WorkerToHostRequest, { type: "host.sidecar" }>
  ) => {
    sidecarTail = sidecarTail.then(async () => {
      switch (request.operation) {
        case "reconcile":
          await sidecar.reconcile(request.wanted === true);
          return { managed: sidecar.managed(), running: sidecar.running() };
        case "refresh":
          await sidecar.refresh();
          return { managed: sidecar.managed(), running: sidecar.running() };
        case "reachable":
          return await sidecar.reachable(request.timeoutMs);
        case "status":
          return { managed: sidecar.managed(), running: sidecar.running() };
      }
    });
    return await sidecarTail;
  };

  const writeRecord = (managed: HostWorkerSession): ServiceRecord => {
    const ready = managed.ready;
    const next = store.write({
      kind: ROUTEKIT_DAEMON_KIND,
      pid: process.pid,
      ...(processIdentity(process.pid) !== undefined
        ? { processIdentity: processIdentity(process.pid) }
        : {}),
      workerPid: ready.workerPid,
      ...(ready.workerProcessIdentity !== undefined
        ? { workerProcessIdentity: ready.workerProcessIdentity }
        : {}),
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
      portless: portless?.enabled ?? false,
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
      url: next.url,
      port: controlPort,
      generation: ready.generation,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      dataUrl,
      dataPort,
      startedAt: hostStartedAt
    });
    return next;
  };

  const retireWorker = (managed: HostWorkerSession): void => {
    setTimeout(() => {
      if (retirementFallback?.id !== managed.id) return;
      retirementFallback = undefined;
      managed.retire();
    }, 250).unref();
  };

  const verifySharedGateway = async (): Promise<void> => {
    const tokenPath = options.authTokenFile ?? join(home, "secrets", "data-token");
    const { readFileSync } = await import("node:fs");
    const token = readFileSync(tokenPath, "utf8").trim();
    const health = await fetch(`${dataUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`candidate gateway health failed (${health.status})`);
    const models = await fetch(gatewayPath(dataUrl, "/v1/models"), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!models.ok) throw new Error(`candidate model readiness failed (${models.status})`);
  };

  const hostState = (rollingState: boolean) => ({
    type: "worker.hostState" as const,
    dataUrl,
    hostPid: process.pid,
    hostStartedAt,
    rolling: rollingState
  });

  const roll = async (
    params: RouteKitControlParams["daemon.roll"]
  ): Promise<RouteKitControlResults["daemon.roll"]> => {
    if (rollRun !== undefined) return await rollRun;
    rollRun = (async () => {
      const previousActive = active;
      if (previousActive === undefined) throw new Error("RouteKit daemon has no active worker");
      if (params.expectedGeneration !== previousActive.ready.generation) {
        throw new Error(
          `daemon generation conflict: expected ${params.expectedGeneration}, current ${previousActive.ready.generation}`
        );
      }
      const binPath = params.candidate?.binPath ?? previousActive.binPath;
      const expectedVersion =
        params.candidate?.expectedVersion ?? previousActive.ready.packageVersion;
      console.error("routekit daemon roll requested", {
        reason: params.reason,
        generation: previousActive.ready.generation,
        fromVersion: previousActive.ready.packageVersion,
        toVersion: expectedVersion
      });
      if (!isAbsolute(binPath)) throw new Error("daemon roll candidate path must be absolute");
      const probed = candidateVersion(binPath);
      if (probed !== expectedVersion) {
        throw new Error(
          `daemon roll candidate reported ${probed ?? "no version"}; expected ${expectedVersion}`
        );
      }
      await previousActive.request(hostState(true));
      const stable = await previousActive.request<{
        configRevision: number;
        accountRevision: number;
        configHash: string;
      }>({ type: "worker.pause" });
      const nextGeneration = nextServiceGeneration(previousActive.ready.generation);
      return await effectRuntime.runPromise(
        runHostGenerationTransactionEffect({
          prepare: async () =>
            await workers.spawn({
              binPath,
              generation: nextGeneration,
              initiallyPaused: true,
              expectedVersion
            }),
          validate: async (candidate) => {
            console.error("routekit daemon candidate prepared", {
              generation: candidate.ready.generation,
              workerPid: candidate.ready.workerPid,
              version: candidate.ready.packageVersion
            });
            if (
              candidate.ready.configRevision !== stable.configRevision ||
              candidate.ready.accountRevision !== stable.accountRevision ||
              candidate.ready.configHash !== stable.configHash
            ) {
              throw new Error("candidate state changed while synchronizing; retry the daemon roll");
            }
            console.error("routekit daemon candidate synchronized", {
              generation: candidate.ready.generation,
              configRevision: candidate.ready.configRevision,
              accountRevision: candidate.ready.accountRevision
            });
            await verifySharedGateway();
            console.error("routekit daemon candidate active", {
              generation: candidate.ready.generation,
              workerPid: candidate.ready.workerPid
            });
          },
          persist: async (candidate) => {
            await candidate.request(hostState(false));
            await candidate.request({ type: "worker.resume" });
            generation = nextGeneration;
            revisions.daemon = generation;
            writeDaemonRevisions(home, revisions);
          },
          commit: (candidate) => {
            active = candidate;
            record = writeRecord(candidate);
            console.error("routekit daemon worker generation committed", {
              generation,
              workerPid: candidate.ready.workerPid
            });
            retirementFallback = previousActive;
            console.error("routekit daemon previous worker retiring", {
              generation: previousActive.ready.generation,
              workerPid: previousActive.ready.workerPid
            });
            return {
              rolled: true,
              reason: params.reason,
              previousGeneration: previousActive.ready.generation,
              generation,
              previousWorkerPid: previousActive.ready.workerPid,
              workerPid: candidate.ready.workerPid,
              packageVersion: candidate.ready.packageVersion
            };
          },
          rollback: async (candidate, error) => {
            console.error("routekit daemon roll rolled back", {
              reason: params.reason,
              stage: candidate === undefined ? "preparation" : "activation",
              error: error instanceof Error ? error.message : String(error)
            });
            if (candidate !== undefined) await candidate.shutdown();
            active = previousActive;
            generation = previousActive.ready.generation;
            revisions.daemon = generation;
            writeDaemonRevisions(home, revisions);
            record = writeRecord(previousActive);
            await previousActive.request({ type: "worker.resume" });
            await previousActive.request(hostState(false));
          },
          retire: () => {
            retireWorker(previousActive);
          }
        })
      );
    })();
    try {
      return await rollRun;
    } finally {
      rollRun = undefined;
    }
  };

  const close = (): Promise<void> => {
    closeRun ??= (async () => {
      if (closed) return;
      closed = true;
      const live = Object.values(cluster.workers ?? {}).filter(
        (worker): worker is Worker => worker !== undefined
      );
      await workers.shutdownAll(live);
      await sidecar.close();
      await effectRuntime.dispose();
      if (portless?.enabled) portless.unregister("gateway");
      store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
      removeDaemonPublicRecord(home);
      authority.release();
    })();
    return closeRun;
  };

  const handleMessage = (worker: Worker, message: HostWorkerMessage): void => {
    if (workers.accept(worker, message)) return;
    if (message.type === "host.sidecar") {
      void sidecarOperation(message).then(
        (result) =>
          sendHostResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: true,
            result
          }),
        (error: unknown) =>
          sendHostResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
      );
      return;
    }
    if (message.type === "host.idempotency.begin") {
      void idempotency.begin(message.method, message.key, message.fingerprint, worker.id).then(
        (result) =>
          sendHostResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: true,
            result
          }),
        (error: unknown) =>
          sendHostResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof ControlError ? { code: error.code } : {})
          })
      );
      return;
    }
    if (message.type === "host.idempotency.complete") {
      try {
        idempotency.complete(message.operationId, message.result);
        sendHostResponse(worker, {
          type: "host.response",
          requestId: message.requestId,
          ok: true
        });
      } catch (error) {
        sendHostResponse(worker, {
          type: "host.response",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    if (message.type === "host.idempotency.fail") {
      idempotency.fail(message.operationId);
      sendHostResponse(worker, {
        type: "host.response",
        requestId: message.requestId,
        ok: true
      });
      return;
    }
    if (message.type === "host.roll") {
      if (active?.id !== worker.id) {
        sendHostResponse(worker, {
          type: "host.response",
          requestId: message.requestId,
          ok: false,
          error: "only the active daemon worker may request a roll"
        });
        return;
      }
      void roll(message.params).then(
        (result) =>
          sendHostResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: true,
            result
          }),
        (error: unknown) =>
          sendHostResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
      );
      return;
    }
    if (message.type === "host.shutdown") {
      void close().finally(() => process.exit(0));
    }
  };

  cluster.on("message", (worker, message) => handleMessage(worker, message as HostWorkerMessage));
  cluster.on("exit", (worker) => {
    idempotency.failOwner(worker.id);
    workers.drop(worker);
    if (!closed && active?.id === worker.id) {
      const failed = active;
      active = undefined;
      const fallback = retirementFallback;
      if (fallback !== undefined && !fallback.worker.isDead()) {
        retirementFallback = undefined;
        recoveryRun ??= (async () => {
          try {
            active = fallback;
            generation = fallback.ready.generation;
            revisions.daemon = generation;
            writeDaemonRevisions(home, revisions);
            record = writeRecord(fallback);
            await fallback.request(hostState(false));
            await fallback.request({ type: "worker.resume" });
            console.error("routekit daemon roll rolled back after committed worker exit", {
              generation,
              workerPid: fallback.ready.workerPid
            });
          } catch (error) {
            console.error("routekit daemon committed rollback failed", error);
            await close();
            process.exit(1);
          } finally {
            recoveryRun = undefined;
          }
        })();
        return;
      }
      recoveryRun ??= (async () => {
        console.error("routekit daemon active worker exited; attempting committed respawn", {
          generation: failed.ready.generation,
          workerPid: failed.ready.workerPid
        });
        try {
          const replacement = await workers.spawn({
            binPath: failed.binPath,
            generation: failed.ready.generation,
            initiallyPaused: false,
            expectedVersion: failed.ready.packageVersion
          });
          active = replacement;
          record = writeRecord(replacement);
          await replacement.request(hostState(false));
          if (retirementFallback !== undefined) retireWorker(retirementFallback);
          console.error("routekit daemon committed worker respawned", {
            generation: replacement.ready.generation,
            workerPid: replacement.ready.workerPid
          });
        } catch (error) {
          console.error("routekit daemon committed worker respawn failed", error);
          await close();
          process.exit(1);
        } finally {
          recoveryRun = undefined;
        }
      })();
    }
  });

  extendCleanupGrace(drainGraceMs + RETIRE_FORCE_EXTRA_MS);
  registerCleanup(close);
  try {
    active = await workers.spawn({
      binPath: options.entryPath,
      generation,
      initiallyPaused: false,
      expectedVersion: options.packageVersion
    });
    portless = await createPortlessSession(options.portless ?? env.ROUTEKIT_PORTLESS !== "0", {
      project: ROUTEKIT_PRODUCT,
      ownerLabel: "routekit-daemon",
      bareNames: []
    });
    dataUrl = portless.enabled
      ? portless.register("gateway", dataPort)
      : loopbackUrl(host, dataPort);
    await active.request(hostState(false));
    record = writeRecord(active);
    return { record, dataUrl, controlUrl: record.url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
