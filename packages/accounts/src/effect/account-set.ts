import { routeKitError, withAbortSignal } from "@velum-labs/routekit-runtime/effect";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { Effect } from "effect";

import {
  SubscriptionAccountSet,
  type SubscriptionAccountSetOptions
} from "../account-set.js";
import type { SubscriptionAccountSetSnapshot } from "../types.js";
import type { SubscriptionProvider } from "../provider.js";

/**
 * Effect façade over a subscription account set.
 *
 * Construction, probe fibers, and ResourceScope disposal stay on
 * `SubscriptionAccountSet`. This adapter owns scoped lifetime and AbortSignal
 * interruption at the Effect boundary.
 */
export class EffectSubscriptionAccountSet<M extends SubscriptionMode = SubscriptionMode> {
  readonly #inner: SubscriptionAccountSet<M>;

  constructor(inner: SubscriptionAccountSet<M>) {
    this.#inner = inner;
  }

  get inner(): SubscriptionAccountSet<M> {
    return this.#inner;
  }

  get mode(): M {
    return this.#inner.mode as M;
  }

  get size(): number {
    return this.#inner.size;
  }

  snapshot(): Effect.Effect<SubscriptionAccountSetSnapshot> {
    return Effect.sync(() => this.#inner.snapshot());
  }

  statusSnapshot(): Effect.Effect<SubscriptionAccountSetSnapshot> {
    return Effect.sync(() => this.#inner.statusSnapshot());
  }

  discoverModels(signal?: AbortSignal): Effect.Effect<readonly string[], Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: () => this.#inner.discoverModels(signal),
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }

  probe(signal?: AbortSignal): Effect.Effect<void, Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: () => this.#inner.probe(signal),
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }

  close(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.close(),
      catch: (cause) => routeKitError(cause)
    });
  }
}

export function openSubscriptionAccountSet<M extends SubscriptionMode>(
  provider: SubscriptionProvider<M>,
  options: SubscriptionAccountSetOptions = {}
): Effect.Effect<EffectSubscriptionAccountSet<M>, Error> {
  return Effect.tryPromise({
    try: async () =>
      new EffectSubscriptionAccountSet(await SubscriptionAccountSet.open(provider, options)),
    catch: (cause) => routeKitError(cause)
  });
}

/**
 * Open an account set that is closed exactly once when the current scope
 * ends, including on interruption. Probe fibers are torn down by `close()`.
 */
export function scopedSubscriptionAccountSet<M extends SubscriptionMode>(
  provider: SubscriptionProvider<M>,
  options: SubscriptionAccountSetOptions = {}
) {
  return Effect.acquireRelease(openSubscriptionAccountSet(provider, options), (accountSet) =>
    accountSet.close().pipe(Effect.ignore)
  );
}
