import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  HostWorkerCoordinator,
  type HostWorkerSession,
  type HostWorkerSpawnEnv,
  type HostWorkerSpawnInput
} from "../host-worker-session.js";

export type { HostGenerationTransaction } from "../host-generation-transaction.js";
export { runHostGenerationTransactionEffect } from "../host-generation-transaction.js";

/**
 * Effect façade over one cluster worker session. Shutdown is the owned
 * finalizer; `retire()` remains fire-and-forget after publication.
 */
export function scopedHostWorkerSession(session: HostWorkerSession) {
  return Effect.acquireRelease(Effect.succeed(session), (owned) =>
    Effect.tryPromise({
      try: () => owned.shutdown(),
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.ignore)
  );
}

export class EffectHostWorkerCoordinator {
  readonly #inner: HostWorkerCoordinator;

  constructor(inner: HostWorkerCoordinator) {
    this.#inner = inner;
  }

  get inner(): HostWorkerCoordinator {
    return this.#inner;
  }

  spawn(input: HostWorkerSpawnInput): Effect.Effect<HostWorkerSession, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.spawn(input),
      catch: (cause) => routeKitError(cause)
    });
  }

  scopedSpawn(input: HostWorkerSpawnInput) {
    return Effect.acquireRelease(this.spawn(input), (session) =>
      Effect.tryPromise({
        try: () => session.shutdown(),
        catch: (cause) => routeKitError(cause)
      }).pipe(Effect.ignore)
    );
  }
}

export function makeEffectHostWorkerCoordinator(
  spawnEnv: HostWorkerSpawnEnv
): EffectHostWorkerCoordinator {
  return new EffectHostWorkerCoordinator(new HostWorkerCoordinator(spawnEnv));
}
