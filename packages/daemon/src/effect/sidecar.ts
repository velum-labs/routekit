import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { type CliproxySidecar, createCliproxySidecar } from "../cliproxy-sidecar.js";

/**
 * Effect façade over the daemon-owned CLIProxyAPI sidecar supervisor.
 *
 * Spawn, crash-respawn, and readiness polling stay on `createCliproxySidecar`.
 * Scope close stops the managed process exactly once.
 */
export class EffectCliproxySidecar {
  readonly #inner: CliproxySidecar;

  constructor(inner: CliproxySidecar) {
    this.#inner = inner;
  }

  get inner(): CliproxySidecar {
    return this.#inner;
  }

  reconcile(wanted: boolean): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.reconcile(wanted),
      catch: (cause) => routeKitError(cause)
    });
  }

  refresh(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.refresh(),
      catch: (cause) => routeKitError(cause)
    });
  }

  running(): Effect.Effect<boolean> {
    return Effect.sync(() => this.#inner.running());
  }

  managed(): Effect.Effect<boolean> {
    return Effect.sync(() => this.#inner.managed());
  }

  reachable(timeoutMs?: number): Effect.Effect<boolean, never, HttpClient.HttpClient> {
    return this.#inner.reachable(timeoutMs);
  }

  close(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.close(),
      catch: (cause) => routeKitError(cause)
    });
  }
}

export function makeEffectCliproxySidecar(input: {
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): EffectCliproxySidecar {
  return new EffectCliproxySidecar(createCliproxySidecar(input));
}

export function scopedCliproxySidecar(input: {
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}) {
  return Effect.acquireRelease(
    Effect.sync(() => makeEffectCliproxySidecar(input)),
    (sidecar) => sidecar.close().pipe(Effect.ignore)
  );
}
