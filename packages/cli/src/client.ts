/**
 * Thin-client bootstrap for the singleton RouteKit daemon.
 *
 * Every product command uses `routekitClient`: discover the authoritative
 * daemon record, authenticate health + hello, and race-safely auto-start it
 * when absent. UI, terminal interaction, and local tool spawning stay outside
 * the daemon.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  globalRouterConfigPath,
  loadRouterConfig,
  routekitHome
} from "@velum-labs/routekit-config";
import { RouteKitControlClient } from "@velum-labs/routekit-control";
import type { ServiceRecord, StartDaemonResult } from "@velum-labs/routekit-runtime";
import {
  acquireLifecycleLock,
  ControlClient,
  createServiceRecordStore,
  detectSupervisor,
  generateControlToken,
  serviceLogPath,
  startDaemon,
  stopDaemonProcess,
  supervisorController,
  supervisorOperationTimeoutMs,
  waitForServiceReady,
  writeFileAtomic
} from "@velum-labs/routekit-runtime";
import { executeWebRequest } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  activeCliSession,
  type CliSession,
  cliTry,
  cliTryPromise,
  type ResolvedTelemetryTarget,
  runCliEffect
} from "./cli-session.js";
import { daemonUnitSpec, missingServiceCredentialVariables, serviceEnvironment } from "./daemon.js";
import { readDaemonPublicRecord, readPeerPointer } from "./peer.js";
import { remoteControlClient } from "./ssh-control.js";
import { routekitVersion } from "./state.js";
import { resolveTarget } from "./target.js";

const PRODUCT = "routekit";
const KIND = "daemon";
const START_TIMEOUT_MS = 90_000;

/** Returns only a client already resolved by this invocation; never starts a daemon. */
export function telemetryTargetIfResolved(
  session: CliSession
): ResolvedTelemetryTarget | undefined {
  return session.telemetryTarget;
}

function defaultDaemonPort(): number {
  const raw = process.env.ROUTEKIT_DAEMON_PORT;
  if (raw === undefined) return 8080;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ROUTEKIT_DAEMON_PORT must be an integer between 0 and 65535");
  }
  return port;
}
export function daemonDataTokenPath(): string {
  return join(routekitHome(), "secrets", "data-token");
}

export function ensureDaemonDataToken(authToken?: string): string {
  const path = daemonDataTokenPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token =
    authToken ?? (existsSync(path) ? readFileSync(path, "utf8").trim() : generateControlToken());
  if (token.length === 0) throw new Error("RouteKit data-plane token is empty");
  writeFileAtomic(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function daemonStore() {
  return createServiceRecordStore({ home: routekitHome(), product: PRODUCT });
}

export function readDaemonRecord(): ServiceRecord | undefined {
  return daemonStore().read(KIND);
}

export function controlClientForRecord(record: ServiceRecord): RouteKitControlClient {
  if (record.controlToken === undefined) {
    throw new Error("RouteKit daemon record has no control credential");
  }
  return new RouteKitControlClient({
    url: record.url,
    token: record.controlToken,
    packageVersion: routekitVersion(),
    cwd: process.cwd(),
    timeoutMs: (record.drainGraceMs ?? 30_000) * 2 + 30_000
  });
}

export function daemonRecordHealthy(
  record: ServiceRecord
): Effect.Effect<boolean, never, HttpClient.HttpClient> {
  if (record.controlToken === undefined) return Effect.succeed(false);
  return new ControlClient({
    url: record.url,
    token: record.controlToken,
    timeoutMs: 1_500
  })
    .health()
    .pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    );
}

function recordIsHealthy(record: ServiceRecord): Promise<boolean> {
  return runCliEffect(daemonRecordHealthy(record));
}

export function canonicalConfigOrMigrationError(): string {
  const global = globalRouterConfigPath();
  if (existsSync(global)) return global;
  throw new Error(
    `canonical router config not found: ${global}; run \`routekit config init\` for a local daemon ` +
      "or `routekit remote add <name> --url <https-url> --ssh <host>` to use a shared gateway"
  );
}

export function daemonServeArgs(
  input: {
    configPath?: string;
    host?: string;
    port?: number;
    authTokenFile?: string;
    portless?: boolean;
    drainGraceMs?: number;
  } = {}
): string[] {
  return [
    // The spawned/supervised child inherits the caller's remote registry, where
    // an active remote makes `daemon run` refuse as a remote-targeted command.
    "--local",
    "daemon",
    "run",
    "--config-path",
    input.configPath ?? canonicalConfigOrMigrationError(),
    "--host",
    input.host ?? "127.0.0.1",
    "--port",
    String(input.port ?? defaultDaemonPort()),
    ...(input.authTokenFile !== undefined ? ["--auth-token-file", input.authTokenFile] : []),
    ...(input.portless === false ? ["--no-portless"] : []),
    ...(input.drainGraceMs !== undefined ? ["--drain-grace-ms", String(input.drainGraceMs)] : [])
  ];
}

function peerServiceRecord(peer: {
  publicRecordPath: string;
  controlToken: string;
}): ServiceRecord {
  const pub = readDaemonPublicRecord(peer.publicRecordPath);
  return {
    product: PRODUCT,
    owner: PRODUCT,
    kind: KIND,
    pid: -1,
    url: pub.url,
    port: pub.port,
    startedAt: pub.startedAt,
    controlToken: peer.controlToken,
    protocolVersion: pub.protocolVersion,
    generation: pub.generation,
    ...(pub.dataUrl !== undefined ? { dataUrl: pub.dataUrl } : {}),
    ...(pub.dataPort !== undefined ? { dataPort: pub.dataPort } : {})
  };
}

const PEER_DAEMON_DOWN = "shared RouteKit daemon is not running; ask the owner to start it";
const PEER_UNAUTHORIZED =
  "the shared RouteKit daemon rejected this account's control token; " +
  "ask the owner for a fresh join credential with `routekit token issue <label> --plane control`";

type PeerConnection =
  | { kind: "none" }
  | { kind: "down" }
  | { kind: "unauthorized" }
  | { kind: "connected"; client: RouteKitControlClient; record: ServiceRecord };

/**
 * Classify a failed peer handshake. A revoked or mistyped control token is an
 * authorization problem, not a stopped daemon, and must not be reported as one.
 */
function peerHandshakeFailure(record: ServiceRecord) {
  return executeWebRequest(`${record.url}/control/v2/health`, {
    headers: { authorization: `Bearer ${record.controlToken}` },
    signal: AbortSignal.timeout(2_000)
  }).pipe(
    Effect.map((response) =>
      response.status === 401 || response.status === 403
        ? ("unauthorized" as const)
        : ("down" as const)
    ),
    Effect.orElseSucceed(() => "down" as const)
  );
}

/** Shake hands with a shared daemon using a peer's control credential. */
function handshakeAsPeer(peer: {
  publicRecordPath: string;
  controlToken: string;
}): Effect.Effect<PeerConnection, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const record = yield* cliTry(() => peerServiceRecord(peer)).pipe(
      Effect.catch(() => Effect.succeed(undefined))
    );
    if (record === undefined) return { kind: "down" as const };
    const client = yield* cliTry(() => controlClientForRecord(record));
    return yield* client.hello().pipe(
      Effect.as({ kind: "connected" as const, client, record }),
      Effect.catch(() =>
        peerHandshakeFailure(record).pipe(Effect.map((kind) => ({ kind }) as PeerConnection))
      )
    );
  });
}

/** Connect to another account's shared daemon through the peer pointer. */
function connectPeerDaemon(): Effect.Effect<PeerConnection, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const peer = yield* cliTry(() => readPeerPointer());
    if (peer === undefined) return { kind: "none" as const };
    return yield* handshakeAsPeer(peer);
  });
}

function peerConnectionError(kind: "down" | "unauthorized"): Error {
  return new Error(kind === "unauthorized" ? PEER_UNAUTHORIZED : PEER_DAEMON_DOWN);
}

/**
 * Prove a join credential works before it is stored. A paste-ready credential
 * that turns out to be stale should fail at enrollment, not on the next
 * unrelated command.
 */
export function assertPeerCredentialUsable(peer: {
  publicRecordPath: string;
  controlToken: string;
}): Effect.Effect<void, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    // Surfaces the precise not-found / unreadable diagnostics.
    yield* cliTry(() => readDaemonPublicRecord(peer.publicRecordPath));
    const connection = yield* handshakeAsPeer(peer);
    if (connection.kind !== "connected") {
      return yield* Effect.fail(
        peerConnectionError(connection.kind === "unauthorized" ? "unauthorized" : "down")
      );
    }
  });
}

function connectedClient(
  record: ServiceRecord
): Effect.Effect<
  { client: RouteKitControlClient; record: ServiceRecord },
  Error,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const client = yield* cliTry(() => controlClientForRecord(record));
    yield* client.hello();
    return { client, record };
  });
}

type EnsureDaemonInput = {
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
  portless?: boolean;
  drainGraceMs?: number;
  lifecycleLockHeld?: boolean;
};

type EnsureDaemonResult = {
  client: RouteKitControlClient;
  record: ServiceRecord;
  start?: StartDaemonResult;
};

function ensureDaemonInternal(
  input: EnsureDaemonInput = {}
): Effect.Effect<EnsureDaemonResult, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const current = readDaemonRecord();
    if (current === undefined) {
      const peer = yield* connectPeerDaemon();
      if (peer.kind === "connected") return { client: peer.client, record: peer.record };
      if (peer.kind !== "none") return yield* Effect.fail(peerConnectionError(peer.kind));
    }
    const requestedConfigPath = yield* cliTry(
      () => input.configPath ?? canonicalConfigOrMigrationError()
    );
    if (current !== undefined && (yield* daemonRecordHealthy(current))) {
      if (
        input.authToken !== undefined &&
        current.authTokenFile !== undefined &&
        readFileSync(current.authTokenFile, "utf8").trim() !== input.authToken
      ) {
        return yield* Effect.fail(
          new Error(
            "RouteKit daemon is already running with a different data-plane token; restart it to rotate credentials"
          )
        );
      }
      if (
        (input.host !== undefined && current.host !== input.host) ||
        (input.port !== undefined && input.port !== 0 && current.dataPort !== input.port) ||
        (input.portless !== undefined && current.portless !== input.portless) ||
        (input.drainGraceMs !== undefined && current.drainGraceMs !== input.drainGraceMs)
      ) {
        return yield* Effect.fail(
          new Error(
            "RouteKit daemon is already running with different listener/lifecycle options; " +
              "restart it with the requested configuration"
          )
        );
      }
      if (current.version !== undefined && current.version !== routekitVersion()) {
        const entry = process.argv[1];
        if (
          (current.supervisor === "systemd" || current.supervisor === "launchd") &&
          current.binPath !== undefined &&
          entry !== undefined &&
          current.binPath !== entry
        ) {
          return yield* Effect.fail(
            new Error(
              `the singleton daemon runs ${current.binPath}, but this CLI is ${entry}; ` +
                "run `routekit daemon service install` to rewrite the unit"
            )
          );
        }
        const lock = yield* cliTryPromise(() => acquireLifecycleLock(daemonLifecycleLockPath()));
        const upgraded = yield* Effect.gen(function* () {
          // Re-read under the lock: another client may already have upgraded it.
          const authoritative = readDaemonRecord();
          if (authoritative === undefined || authoritative.version === routekitVersion()) {
            return undefined;
          }
          const candidateEntry = process.argv[1];
          if (
            (authoritative.hostProtocolVersion ?? 0) >= 1 &&
            authoritative.workerPid !== undefined &&
            authoritative.generation !== undefined &&
            candidateEntry !== undefined
          ) {
            const client = yield* cliTry(() => controlClientForRecord(authoritative));
            const result = yield* client.call(
              "daemon.roll",
              {
                reason: "upgrade",
                expectedGeneration: authoritative.generation,
                candidate: {
                  binPath: candidateEntry,
                  expectedVersion: routekitVersion()
                }
              },
              {
                idempotencyKey: `auto-upgrade-${authoritative.generation}-${routekitVersion()}`
              }
            );
            const replacement = readDaemonRecord();
            if (
              replacement === undefined ||
              replacement.pid !== authoritative.pid ||
              replacement.workerPid !== result.workerPid ||
              replacement.generation !== result.generation ||
              replacement.version !== routekitVersion()
            ) {
              return yield* Effect.fail(
                new Error("rolling daemon auto-upgrade did not publish the expected worker")
              );
            }
            return yield* connectedClient(replacement);
          }
          if (authoritative.supervisor === "systemd" || authoritative.supervisor === "launchd") {
            const supervisor = authoritative.supervisor;
            const timeoutMs = supervisorOperationTimeoutMs(authoritative.drainGraceMs);
            yield* cliTryPromise(() =>
              supervisorController(supervisor, PRODUCT, KIND).restart({
                timeoutMs
              })
            );
            const replacement = yield* cliTryPromise(() =>
              waitForServiceReady({
                home: routekitHome(),
                product: PRODUCT,
                kind: KIND,
                previousPid: authoritative.pid,
                timeoutMs,
                logFile: daemonLogPath(),
                ready: recordIsHealthy
              })
            );
            return yield* connectedClient(replacement);
          }
          const stopped = yield* cliTryPromise(() =>
            stopDaemonProcess(authoritative, {
              graceMs: supervisorOperationTimeoutMs(authoritative.drainGraceMs)
            })
          );
          if (!stopped.stopped) {
            return yield* Effect.fail(
              new Error(
                "cannot auto-upgrade a daemon without verifiable process identity; stop it manually"
              )
            );
          }
          return undefined;
        }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
        if (upgraded !== undefined) return upgraded;
        // Detached daemon: fall through to the ordinary race-safe start after
        // the old generation has drained and removed its record.
        return yield* ensureDaemon({
          ...input,
          port: input.port ?? current.dataPort ?? 8080,
          ...(input.authToken !== undefined
            ? { authToken: input.authToken }
            : current.authToken !== undefined
              ? { authToken: current.authToken }
              : {})
        });
      }
      const client = yield* cliTry(() => controlClientForRecord(current));
      const hello = yield* client.hello();
      if (!hello.capabilities.includes("routekit.control.v2")) {
        return yield* Effect.fail(
          new Error("RouteKit daemon does not advertise routekit.control.v2")
        );
      }
      return { client, record: current };
    }
    if (current !== undefined) {
      return yield* Effect.fail(
        new Error(
          `RouteKit daemon pid ${current.pid} is alive but unhealthy; ` +
            "run `routekit stop --force` before recovery"
        )
      );
    }
    const entry = process.argv[1];
    if (entry === undefined) {
      return yield* Effect.fail(new Error("cannot resolve the routekit entry script"));
    }
    const home = routekitHome();
    const configPath = requestedConfigPath;
    const config = yield* cliTry(() => loadRouterConfig({ configPath }).config);
    const missingCredentials = missingServiceCredentialVariables(config);
    if (missingCredentials.length > 0) {
      return yield* Effect.fail(
        new Error(
          `cannot start RouteKit: set ${missingCredentials.join(" or ")} for the configured provider`
        )
      );
    }
    const authTokenFile = yield* cliTry(() => ensureDaemonDataToken(input.authToken));
    const supervisor =
      input.lifecycleLockHeld === true || process.env.ROUTEKIT_NO_SUPERVISOR === "1"
        ? undefined
        : yield* cliTryPromise(() => detectSupervisor(PRODUCT, KIND));
    if (supervisor !== undefined) {
      const lock = yield* cliTryPromise(() =>
        acquireLifecycleLock(daemonLifecycleLockPath(), {
          timeoutMs: START_TIMEOUT_MS
        })
      );
      return yield* Effect.gen(function* () {
        const joined = readDaemonRecord();
        if (joined !== undefined && (yield* daemonRecordHealthy(joined))) {
          return yield* connectedClient(joined);
        }
        const graceMs = input.drainGraceMs ?? 30_000;
        return yield* cliTryPromise(() =>
          supervisor.install(
            daemonUnitSpec({
              args: daemonServeArgs({ ...input, configPath, authTokenFile }),
              supervisor: supervisor.kind,
              env: serviceEnvironment(config),
              drainGraceMs: graceMs
            })
          )
        ).pipe(
          Effect.andThen(
            cliTryPromise(() =>
              waitForServiceReady({
                home,
                product: PRODUCT,
                kind: KIND,
                timeoutMs: supervisorOperationTimeoutMs(graceMs),
                logFile: daemonLogPath(),
                ready: recordIsHealthy
              })
            )
          ),
          Effect.flatMap((record) =>
            connectedClient(record).pipe(
              Effect.map(({ client }) => ({
                client,
                record,
                start: {
                  alreadyRunning: false as const,
                  record,
                  logFile: daemonLogPath()
                }
              }))
            )
          ),
          Effect.catch((error) =>
            cliTryPromise(() =>
              supervisor
                .uninstall({ timeoutMs: supervisorOperationTimeoutMs(graceMs) })
                .catch(() => undefined)
            ).pipe(Effect.andThen(Effect.fail(error)))
          )
        );
      }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
    }
    const start = yield* cliTryPromise(() =>
      startDaemon(
        {
          product: PRODUCT,
          kind: KIND,
          home,
          version: routekitVersion(),
          command: {
            execPath: process.execPath,
            args: [entry, ...daemonServeArgs({ ...input, configPath, authTokenFile })]
          },
          cwd: process.cwd()
        },
        {
          readyTimeoutMs: START_TIMEOUT_MS,
          ready: recordIsHealthy,
          lockHeld: input.lifecycleLockHeld === true
        }
      )
    );
    const connected = yield* connectedClient(start.record);
    return { client: connected.client, record: start.record, start };
  });
}

export function ensureDaemon(
  input: EnsureDaemonInput = {}
): Effect.Effect<EnsureDaemonResult, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const session = yield* cliTry(() => activeCliSession());
    const resolved = yield* ensureDaemonInternal(input);
    session.telemetryTarget = {
      client: resolved.client,
      kind: resolved.record.pid === -1 ? "peer" : "local"
    };
    return resolved;
  });
}

export function routekitClient(): Effect.Effect<
  RouteKitControlClient,
  Error,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const session = yield* cliTry(() => activeCliSession());
    const target = yield* cliTryPromise(() => resolveTarget());
    if (target.kind === "remote") {
      const client = yield* cliTry(() => remoteControlClient(target.remote));
      session.telemetryTarget = { client, kind: "remote" };
      return client;
    }
    const resolved = yield* ensureDaemon();
    session.telemetryTarget = {
      client: resolved.client,
      kind: resolved.record.pid === -1 ? "peer" : "local"
    };
    return resolved.client;
  });
}

export function connectDaemon(): Effect.Effect<
  { client: RouteKitControlClient; record: ServiceRecord } | undefined,
  Error,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const session = yield* cliTry(() => activeCliSession());
    const record = readDaemonRecord();
    // A peer account owns no service record; its daemon lives in another home.
    if (record === undefined) {
      const peer = yield* connectPeerDaemon();
      if (peer.kind === "connected") return { client: peer.client, record: peer.record };
      // A stopped shared daemon reads as "no daemon"; a rejected token must not.
      if (peer.kind === "unauthorized") {
        return yield* Effect.fail(peerConnectionError(peer.kind));
      }
      return undefined;
    }
    if (!(yield* daemonRecordHealthy(record))) return undefined;
    const connected = yield* connectedClient(record);
    session.telemetryTarget = {
      client: connected.client,
      kind: record.pid === -1 ? "peer" : "local"
    };
    return connected;
  });
}

export function daemonLogPath(): string {
  return serviceLogPath(routekitHome(), KIND);
}

export function daemonLifecycleLockPath(): string {
  return join(routekitHome(), "services", "daemon.lock");
}
