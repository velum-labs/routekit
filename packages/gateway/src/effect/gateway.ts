import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

/** Run a synchronous gateway step as an Effect, preserving Error subclasses. */
export function gatewayTry<A>(run: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: run,
    catch: toRouteKitFailure
  });
}

/** Run an asynchronous gateway step as an Effect, preserving Error subclasses. */
export function gatewayTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: toRouteKitFailure
  });
}
