/**
 * Daemon-owned CLIProxyAPI sidecar.
 *
 * When the router config enables the `cliproxy` provider and the pinned
 * binary is installed under the RouteKit home, the daemon owns the sidecar
 * process: it starts it, restarts it after a crash, and stops it on daemon
 * shutdown. Users never run `cli-proxy-api` themselves. A self-managed
 * external proxy (ROUTEKIT_CLIPROXY_BASE_URL set) is never touched.
 */
import type { ChildProcess } from "node:child_process";

import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  CLIPROXY_PINNED_VERSION,
  cliproxyApiKey,
  cliproxyBaseUrl,
  cliproxyBinaryPath,
  spawnCliproxy
} from "@velum-labs/routekit-accounts";
import {
  executeWebRequest,
  RouteKitFailure,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

const RESPAWN_DELAY_MS = 2_000;
const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 250;
const STOP_GRACE_MS = 5_000;

export type CliproxySidecar = {
  /** Start or stop the managed process to match the desired state. */
  reconcile(wanted: boolean): Effect.Effect<void, Error, HttpClient.HttpClient>;
  /** Restart a wanted managed process so it reloads its auth store. */
  refresh(_unit?: void): Effect.Effect<void, Error, HttpClient.HttpClient>;
  running(): boolean;
  /** True when this daemon manages the sidecar process (not an external URL). */
  managed(): boolean;
  reachable(timeoutMs?: number): Effect.Effect<boolean, never, HttpClient.HttpClient>;
  close(_unit?: void): Effect.Effect<void, Error>;
};

/** The sidecar is managed here unless an external proxy URL is configured. */
export function cliproxyManagedLocally(env: NodeJS.ProcessEnv): boolean {
  return (env[CLIPROXY_BASE_URL_ENV] ?? "").length === 0;
}

export function createCliproxySidecar(input: {
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): CliproxySidecar {
  const env = input.env;
  const log = input.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  let child: ChildProcess | undefined;
  let wanted = false;
  let closed = false;
  let stopping = false;
  let respawnTimer: NodeJS.Timeout | undefined;

  const reachable = (timeoutMs = 1_500): Effect.Effect<boolean, never, HttpClient.HttpClient> => {
    const key = env[CLIPROXY_API_KEY_ENV] ?? cliproxyApiKey(env) ?? "";
    // Any HTTP answer (including 401/403) proves the listener is up.
    return executeWebRequest(`${cliproxyBaseUrl(env)}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs)
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    );
  };

  function scheduleRespawn(): void {
    if (closed || !wanted || stopping || respawnTimer !== undefined) return;
    respawnTimer = setTimeout(() => {
      respawnTimer = undefined;
      spawnOnce();
    }, RESPAWN_DELAY_MS);
    respawnTimer.unref();
  }

  function spawnOnce(): void {
    if (closed || !wanted || child !== undefined) return;
    let spawned: ChildProcess;
    try {
      spawned = spawnCliproxy(env, { stdio: "ignore" });
    } catch (error) {
      log(
        `routekit cliproxy sidecar failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      scheduleRespawn();
      return;
    }
    child = spawned;
    spawned.once("error", (error) => {
      if (child === spawned) child = undefined;
      log(`routekit cliproxy sidecar error: ${error.message}`);
      scheduleRespawn();
    });
    spawned.once("exit", (code, signal) => {
      if (child === spawned) child = undefined;
      if (closed || !wanted || stopping) return;
      log(
        `routekit cliproxy sidecar exited (${signal ?? `code ${code ?? "unknown"}`}); restarting`
      );
      scheduleRespawn();
    });
  }

  const stop = (): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      if (respawnTimer !== undefined) {
        clearTimeout(respawnTimer);
        respawnTimer = undefined;
      }
      const current = child;
      if (current === undefined) return;
      child = undefined;
      stopping = true;
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve) => {
            const killTimer = setTimeout(() => {
              current.kill("SIGKILL");
            }, STOP_GRACE_MS);
            killTimer.unref();
            current.once("exit", () => {
              clearTimeout(killTimer);
              resolve();
            });
            if (!current.kill("SIGTERM")) {
              clearTimeout(killTimer);
              resolve();
            }
          }),
        catch: toRouteKitFailure
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stopping = false;
          })
        )
      );
    });

  const waitUntilReady = (): Effect.Effect<void, Error, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (yield* reachable(READY_POLL_MS * 2)) return;
        yield* Effect.sleep(`${READY_POLL_MS} millis`);
      }
      // Force an unhealthy child through the normal crash-recovery path. Spawn
      // failures already leave a retry timer armed.
      child?.kill("SIGKILL");
      return yield* new RouteKitFailure({
        message: "routekit cliproxy sidecar did not answer within its readiness window"
      });
    });

  return {
    reconcile: (next: boolean): Effect.Effect<void, Error, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        if (closed) return;
        const installable =
          cliproxyManagedLocally(env) &&
          cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env) !== undefined;
        wanted = next && installable;
        if (!wanted) {
          yield* stop();
          return;
        }
        if (child === undefined) spawnOnce();
        // Always wait for readiness — including after a crash respawn left a
        // child handle before the listener was accepting connections.
        yield* waitUntilReady();
      }),
    refresh: (): Effect.Effect<void, Error, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        if (
          closed ||
          !wanted ||
          !cliproxyManagedLocally(env) ||
          cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env) === undefined
        ) {
          return;
        }
        yield* stop();
        spawnOnce();
        yield* waitUntilReady();
      }),
    running: () => child !== undefined,
    managed: () => cliproxyManagedLocally(env),
    reachable,
    close: (): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        closed = true;
        wanted = false;
        yield* stop();
      })
  };
}
