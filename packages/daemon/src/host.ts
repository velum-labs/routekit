import { spawnSync } from "node:child_process";
import cluster from "node:cluster";
import type { Worker } from "node:cluster";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import type { RouteKitControlParams, RouteKitControlResults } from "@velum-labs/routekit-control";
import {
  acquireLifecycleLock,
  CONTROL_PROTOCOL_VERSION,
  createPortlessSession,
  createServiceRecordStore,
  extendCleanupGrace,
  generateControlToken,
  nextServiceGeneration,
  processIdentity,
  registerCleanup,
  supervisorFromEnv,
  gatewayPath
} from "@velum-labs/routekit-runtime";
import type { PortlessSession, ServiceRecord } from "@velum-labs/routekit-runtime";

import { createCliproxySidecar } from "./cliproxy-sidecar.js";
import {
  DAEMON_HOST_PROTOCOL_VERSION,
  type HostToWorkerResponse,
  type HostWorkerMessage,
  ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV,
  ROUTEKIT_DAEMON_CONTROL_PORT_ENV,
  ROUTEKIT_DAEMON_DATA_PORT_ENV,
  ROUTEKIT_DAEMON_DATA_URL_ENV,
  ROUTEKIT_DAEMON_GENERATION_ENV,
  ROUTEKIT_DAEMON_HOST_PID_ENV,
  ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV,
  ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV,
  ROUTEKIT_DAEMON_WORKER_ENV,
  type WorkerReady,
  type WorkerRequest,
  type WorkerToHostRequest
} from "./host-protocol.js";
import type { RouteKitDaemonOptions } from "./index.js";
import {
  readDaemonRevisions,
  removeDaemonPublicRecord,
  ROUTEKIT_DAEMON_KIND,
  ROUTEKIT_PRODUCT,
  writeDaemonPublicRecord,
  writeDaemonRevisions
} from "./index.js";

const WORKER_READY_TIMEOUT_MS = 90_000;
const WORKER_REQUEST_TIMEOUT_MS = 120_000;
const RETIRE_FORCE_EXTRA_MS = 10_000;

type WorkerRequestInput = WorkerRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, "requestId">
    : never
  : never;

type ManagedWorker = { worker: Worker; ready: WorkerReady; binPath: string };

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
  const dataPort = options.port === undefined || options.port === 0 ? await reservePort(host) : options.port;
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
  let rolling = false;
  let active: ManagedWorker | undefined;
  let closed = false;
  let closeRun: Promise<void> | undefined;
  let rollRun: Promise<RouteKitControlResults["daemon.roll"]> | undefined;
  let requestSequence = 0;
  const pending = new Map<
    string,
    {
      workerId: number;
      timer: NodeJS.Timeout;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  const readyWaiters = new Map<
    number,
    { resolve(ready: WorkerReady): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const sidecar = createCliproxySidecar({ env });
  let sidecarTail: Promise<unknown> = Promise.resolve();
  let portless: PortlessSession | undefined;
  let record: ServiceRecord | undefined;
  let recoveryRun: Promise<void> | undefined;
  let retirementFallback: ManagedWorker | undefined;

  const sendResponse = (worker: Worker, response: HostToWorkerResponse): void => {
    if (worker.isConnected()) worker.send(response);
  };

  const requestWorker = async <T>(worker: Worker, request: WorkerRequestInput): Promise<T> => {
    const requestId = `host-${++requestSequence}`;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`daemon worker request ${request.type} timed out`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      timer.unref();
      pending.set(requestId, {
        workerId: worker.id,
        timer,
        resolve: (value) => resolve(value as T),
        reject
      });
    });
    try {
      worker.send({ ...request, requestId } as WorkerRequest);
    } catch (error) {
      const waiter = pending.get(requestId);
      if (waiter !== undefined) clearTimeout(waiter.timer);
      pending.delete(requestId);
      throw error;
    }
    return await response;
  };

  const sidecarOperation = async (request: Extract<WorkerToHostRequest, { type: "host.sidecar" }>) => {
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

  const writeRecord = (managed: ManagedWorker): ServiceRecord => {
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

  const shutdownWorker = async (worker: Worker): Promise<void> => {
    if (worker.isDead()) return;
    try {
      await requestWorker(worker, { type: "worker.shutdown" });
    } catch {
      worker.process.kill("SIGTERM");
    }
  };

  const retireWorker = (managed: ManagedWorker): void => {
    setTimeout(() => {
      if (retirementFallback?.worker.id !== managed.worker.id) return;
      retirementFallback = undefined;
      void requestWorker(managed.worker, { type: "worker.retire", graceMs: drainGraceMs }).catch(() => {
        managed.worker.process.kill("SIGTERM");
      });
      const forced = setTimeout(() => {
        if (!managed.worker.isDead()) managed.worker.process.kill("SIGKILL");
      }, drainGraceMs + RETIRE_FORCE_EXTRA_MS);
      forced.unref();
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

  const spawnWorker = async (input: {
    binPath: string;
    generation: number;
    initiallyPaused: boolean;
    expectedVersion: string;
  }): Promise<ManagedWorker> => {
    cluster.setupPrimary({ exec: input.binPath, args: process.argv.slice(2), silent: false });
    const worker = cluster.fork({
      ...env,
      [ROUTEKIT_DAEMON_WORKER_ENV]: "1",
      [ROUTEKIT_DAEMON_GENERATION_ENV]: String(input.generation),
      [ROUTEKIT_DAEMON_CONTROL_TOKEN_ENV]: controlToken,
      [ROUTEKIT_DAEMON_CONTROL_PORT_ENV]: String(controlPort),
      [ROUTEKIT_DAEMON_DATA_PORT_ENV]: String(dataPort),
      [ROUTEKIT_DAEMON_DATA_URL_ENV]: dataUrl,
      [ROUTEKIT_DAEMON_HOST_PID_ENV]: String(process.pid),
      [ROUTEKIT_DAEMON_HOST_STARTED_AT_ENV]: hostStartedAt,
      [ROUTEKIT_DAEMON_INITIAL_PAUSED_ENV]: input.initiallyPaused ? "1" : "0"
    });
    const ready = await new Promise<WorkerReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiters.delete(worker.id);
        reject(new Error(`daemon worker ${worker.process.pid ?? worker.id} did not become ready`));
      }, WORKER_READY_TIMEOUT_MS);
      timer.unref();
      readyWaiters.set(worker.id, { resolve, reject, timer });
      worker.once("exit", (code, signal) => {
        const waiter = readyWaiters.get(worker.id);
        if (waiter === undefined) return;
        readyWaiters.delete(worker.id);
        clearTimeout(waiter.timer);
        reject(new Error(`daemon worker exited before readiness (${signal ?? `code ${code ?? "unknown"}`})`));
      });
    });
    if (ready.protocolVersion !== DAEMON_HOST_PROTOCOL_VERSION) {
      await shutdownWorker(worker);
      throw new Error(
        `daemon worker host protocol ${ready.protocolVersion} is incompatible with ${DAEMON_HOST_PROTOCOL_VERSION}`
      );
    }
    if (ready.packageVersion !== input.expectedVersion) {
      await shutdownWorker(worker);
      throw new Error(
        `daemon worker version ${ready.packageVersion} did not match expected ${input.expectedVersion}`
      );
    }
    return { worker, ready, binPath: input.binPath };
  };

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
      const expectedVersion = params.candidate?.expectedVersion ?? previousActive.ready.packageVersion;
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
      rolling = true;
      await requestWorker(previousActive.worker, {
        type: "worker.hostState",
        dataUrl,
        hostPid: process.pid,
        hostStartedAt,
        rolling: true
      });
      const stable = await requestWorker<{
        configRevision: number;
        accountRevision: number;
        configHash: string;
      }>(previousActive.worker, { type: "worker.pause" });
      const nextGeneration = nextServiceGeneration(previousActive.ready.generation);
      let candidate: ManagedWorker | undefined;
      try {
        candidate = await spawnWorker({
          binPath,
          generation: nextGeneration,
          initiallyPaused: true,
          expectedVersion
        });
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
        await requestWorker(candidate.worker, {
          type: "worker.hostState",
          dataUrl,
          hostPid: process.pid,
          hostStartedAt,
          rolling: false
        });
        await requestWorker(candidate.worker, { type: "worker.resume" });
        generation = nextGeneration;
        revisions.daemon = generation;
        writeDaemonRevisions(home, revisions);
        active = candidate;
        record = writeRecord(candidate);
        console.error("routekit daemon worker generation committed", {
          generation,
          workerPid: candidate.ready.workerPid
        });
        rolling = false;
        retirementFallback = previousActive;
        console.error("routekit daemon previous worker retiring", {
          generation: previousActive.ready.generation,
          workerPid: previousActive.ready.workerPid
        });
        retireWorker(previousActive);
        return {
          rolled: true,
          reason: params.reason,
          previousGeneration: previousActive.ready.generation,
          generation,
          previousWorkerPid: previousActive.ready.workerPid,
          workerPid: candidate.ready.workerPid,
          packageVersion: candidate.ready.packageVersion
        };
      } catch (error) {
        console.error("routekit daemon roll rolled back", {
          reason: params.reason,
          stage: candidate === undefined ? "preparation" : "activation",
          error: error instanceof Error ? error.message : String(error)
        });
        if (candidate !== undefined) await shutdownWorker(candidate.worker);
        active = previousActive;
        generation = previousActive.ready.generation;
        revisions.daemon = generation;
        writeDaemonRevisions(home, revisions);
        record = writeRecord(previousActive);
        await requestWorker(previousActive.worker, { type: "worker.resume" });
        await requestWorker(previousActive.worker, {
          type: "worker.hostState",
          dataUrl,
          hostPid: process.pid,
          hostStartedAt,
          rolling: false
        });
        rolling = false;
        throw error;
      }
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
      const workers = Object.values(cluster.workers ?? {}).filter(
        (worker): worker is Worker => worker !== undefined
      );
      await Promise.allSettled(workers.map(async (worker) => await shutdownWorker(worker)));
      await sidecar.close();
      if (portless?.enabled) portless.unregister("gateway");
      store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
      removeDaemonPublicRecord(home);
      authority.release();
    })();
    return closeRun;
  };

  const handleMessage = (worker: Worker, message: HostWorkerMessage): void => {
    if (message.type === "worker.ready") {
      const waiter = readyWaiters.get(worker.id);
      if (waiter === undefined) return;
      readyWaiters.delete(worker.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    if (message.type === "worker.response") {
      const waiter = pending.get(message.requestId);
      if (waiter === undefined || waiter.workerId !== worker.id) return;
      pending.delete(message.requestId);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error));
      return;
    }
    if (message.type === "host.sidecar") {
      void sidecarOperation(message).then(
        (result) => sendResponse(worker, { type: "host.response", requestId: message.requestId, ok: true, result }),
        (error: unknown) =>
          sendResponse(worker, {
            type: "host.response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
      );
      return;
    }
    if (message.type === "host.roll") {
      if (active?.worker.id !== worker.id) {
        sendResponse(worker, {
          type: "host.response",
          requestId: message.requestId,
          ok: false,
          error: "only the active daemon worker may request a roll"
        });
        return;
      }
      void roll(message.params).then(
        (result) => sendResponse(worker, { type: "host.response", requestId: message.requestId, ok: true, result }),
        (error: unknown) =>
          sendResponse(worker, {
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
    for (const [requestId, waiter] of pending) {
      if (waiter.workerId !== worker.id) continue;
      pending.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("daemon worker exited"));
    }
    if (!closed && active?.worker.id === worker.id) {
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
            await requestWorker(fallback.worker, {
              type: "worker.hostState",
              dataUrl,
              hostPid: process.pid,
              hostStartedAt,
              rolling: false
            });
            await requestWorker(fallback.worker, { type: "worker.resume" });
            rolling = false;
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
          const replacement = await spawnWorker({
            binPath: failed.binPath,
            generation: failed.ready.generation,
            initiallyPaused: false,
            expectedVersion: failed.ready.packageVersion
          });
          active = replacement;
          record = writeRecord(replacement);
          await requestWorker(replacement.worker, {
            type: "worker.hostState",
            dataUrl,
            hostPid: process.pid,
            hostStartedAt,
            rolling: false
          });
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
    active = await spawnWorker({
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
    dataUrl = portless.enabled ? portless.register("gateway", dataPort) : loopbackUrl(host, dataPort);
    await requestWorker(active.worker, {
      type: "worker.hostState",
      dataUrl,
      hostPid: process.pid,
      hostStartedAt,
      rolling: false
    });
    record = writeRecord(active);
    return { record, dataUrl, controlUrl: record.url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
