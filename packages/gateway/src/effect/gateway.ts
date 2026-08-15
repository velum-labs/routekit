import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

/** Run a synchronous gateway step as an Effect, tagging failures. */
export function gatewayTry<A>(run: () => A): Effect.Effect<A, RouteKitFailure> {
  return Effect.try({
    try: run,
    catch: (cause) => toRouteKitFailure(cause)
  });
}

/** Run an asynchronous gateway step as an Effect, tagging failures. */
export function gatewayTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, RouteKitFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toRouteKitFailure(cause)
  });
}
