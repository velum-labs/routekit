import { Effect } from "effect";

import {
  type CapacityLease,
  CapacityPool,
  type CapacityPoolMember,
  type CapacityPoolOptions
} from "../capacity-pool.js";
import { routeKitError } from "./errors.js";

/**
 * Effect façade over RouteKit's capacity pool.
 *
 * Selection and cooldown policy stay on `CapacityPool`. This adapter owns
 * lease lifetime: interruption and scope close release exactly once.
 */
export class EffectCapacityPool<T> {
  readonly #pool: CapacityPool<T>;

  constructor(members: readonly CapacityPoolMember<T>[], options: CapacityPoolOptions = {}) {
    this.#pool = new CapacityPool(members, options);
  }

  list(): Effect.Effect<readonly CapacityPoolMember<T>[]> {
    return Effect.sync(() => this.#pool.list());
  }

  acquire(
    stickyKey = "default",
    excluded: ReadonlySet<string> = new Set()
  ): Effect.Effect<CapacityLease<T>, Error> {
    return Effect.try({
      try: () => this.#pool.acquire(stickyKey, excluded),
      catch: (cause) => routeKitError(cause)
    });
  }

  /**
   * Acquire a lease that is released exactly once when the current scope
   * closes, including on interruption.
   */
  acquireScoped(stickyKey = "default", excluded: ReadonlySet<string> = new Set()) {
    return Effect.acquireRelease(this.acquire(stickyKey, excluded), (lease) =>
      Effect.sync(() => {
        lease.release();
      })
    );
  }

  update(
    id: string,
    state: Partial<Omit<CapacityPoolMember<T>, "id" | "value">>
  ): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => this.#pool.update(id, state),
      catch: (cause) => routeKitError(cause)
    });
  }

  markHealthy(id: string): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => this.#pool.markHealthy(id),
      catch: (cause) => routeKitError(cause)
    });
  }

  markFailure(id: string, cooldownMs: number): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => this.#pool.markFailure(id, cooldownMs),
      catch: (cause) => routeKitError(cause)
    });
  }
}

export function makeEffectCapacityPool<T>(
  members: readonly CapacityPoolMember<T>[],
  options: CapacityPoolOptions = {}
): EffectCapacityPool<T> {
  return new EffectCapacityPool(members, options);
}
