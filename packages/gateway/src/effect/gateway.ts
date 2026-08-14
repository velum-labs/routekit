import {
  runRouteKitEffect,
  runRouteKitEffectWith,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { type Context, Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

/** Run a backend request Effect at a remaining Promise product edge. */
export function runBackendRequest<A, E>(
  platform: Context.Context<HttpClient.HttpClient> | undefined,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>
): Promise<A> {
  return platform === undefined
    ? runRouteKitEffect(effect)
    : runRouteKitEffectWith(platform, effect);
}

/** Run a synchronous gateway step as an Effect, preserving Error subclasses. */
export function gatewayTry<A>(run: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : toRouteKitFailure(cause))
  });
}

/** Run an asynchronous gateway step as an Effect, preserving Error subclasses. */
export function gatewayTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : toRouteKitFailure(cause))
  });
}
