import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

/** Run a synchronous control use case as an Effect, preserving ControlError. */
export function controlTry<A>(run: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: run,
    catch: toRouteKitFailure
  });
}

/** Run an asynchronous control use case as an Effect, preserving ControlError. */
export function controlTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: toRouteKitFailure
  });
}
