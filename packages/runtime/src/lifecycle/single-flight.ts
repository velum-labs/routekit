import { Deferred, Effect, SynchronizedRef } from "effect";

type InFlight = Map<string, Deferred.Deferred<unknown, unknown>>;

type Claim =
  | { readonly kind: "join"; readonly deferred: Deferred.Deferred<unknown, unknown> }
  | { readonly kind: "own"; readonly deferred: Deferred.Deferred<unknown, unknown> };

export type SingleFlight = {
  /**
   * Run `work` once per in-flight `key`. Concurrent callers join the owner's
   * result. Interrupting a waiter does not interrupt the owner; interrupting
   * the owner fails waiters with the same cause.
   *
   * This is in-flight sharing, not a result cache: a later call after the
   * owner finishes runs `work` again. Shared work that must survive caller
   * cancellation should wrap `work` in `Effect.uninterruptible` (or fork it
   * into a longer-lived scope) before passing it in.
   */
  readonly run: <A, E, R>(key: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

/**
 * Build a SynchronizedRef/Deferred single-flight helper.
 *
 * RouteKit coordination (auth recovery, rate-limit refresh, discovery) should
 * reuse this rather than each inventing a waiter map.
 */
export const makeSingleFlight: Effect.Effect<SingleFlight> = Effect.gen(function* () {
  const slots = yield* SynchronizedRef.make<InFlight>(new Map());

  const run = <A, E, R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* SynchronizedRef.modify(slots, (map): readonly [Claim, InFlight] => {
          const current = map.get(key);
          if (current !== undefined) {
            return [{ kind: "join", deferred: current }, map];
          }
          const deferred = Deferred.makeUnsafe<unknown, unknown>();
          const next = new Map(map);
          next.set(key, deferred);
          return [{ kind: "own", deferred }, next];
        });

        if (claimed.kind === "join") {
          return yield* restore(Deferred.await(claimed.deferred as Deferred.Deferred<A, E>));
        }

        const deferred = claimed.deferred as Deferred.Deferred<A, E>;
        return yield* Effect.ensuring(
          restore(
            Effect.gen(function* () {
              yield* Deferred.complete(deferred, work);
              return yield* Deferred.await(deferred);
            })
          ),
          SynchronizedRef.update(slots, (map) => {
            const next = new Map(map);
            next.delete(key);
            return next;
          })
        );
      })
    ) as Effect.Effect<A, E, R>;

  return { run };
});
