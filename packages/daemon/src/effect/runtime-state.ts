import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  DaemonRuntimeState,
  type DaemonLifecycle,
  type DaemonRuntimeSnapshot
} from "../daemon-runtime-state.js";

/**
 * Effect façade over daemon runtime-state mutation serialization.
 *
 * Pause/resume/lifecycle flags stay on `DaemonRuntimeState`. Overlapping
 * mutations still share one tail so generations cannot interleave.
 */
export class EffectDaemonRuntimeState {
  readonly #inner: DaemonRuntimeState;

  constructor(inner: DaemonRuntimeState) {
    this.#inner = inner;
  }

  get inner(): DaemonRuntimeState {
    return this.#inner;
  }

  get lifecycle(): DaemonLifecycle {
    return this.#inner.lifecycle;
  }

  snapshot(): Effect.Effect<DaemonRuntimeSnapshot> {
    return Effect.sync(() => this.#inner.snapshot());
  }

  serializeMutation<T>(operation: () => Promise<T>): Effect.Effect<T, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.serializeMutation(operation),
      catch: (cause) => routeKitError(cause)
    });
  }

  awaitMutations(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.awaitMutations(),
      catch: (cause) => routeKitError(cause)
    });
  }

  pause(): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => {
        this.#inner.pause();
      },
      catch: (cause) => routeKitError(cause)
    });
  }

  resume(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#inner.resume();
    });
  }
}

export function makeEffectDaemonRuntimeState(
  inner: DaemonRuntimeState
): EffectDaemonRuntimeState {
  return new EffectDaemonRuntimeState(inner);
}
