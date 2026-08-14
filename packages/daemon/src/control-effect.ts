import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

/** Run a synchronous control use case as an Effect, tagging failures. */
export function controlTry<A>(run: () => A): Effect.Effect<A, RouteKitFailure> {
  return Effect.try({
    try: run,
    catch: (cause) => toRouteKitFailure(cause)
  });
}

/** Run an asynchronous control use case as an Effect, tagging failures. */
export function controlTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, RouteKitFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toRouteKitFailure(cause)
  });
}
