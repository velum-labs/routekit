import {
  runRouteKitEffect,
  runRouteKitEffectWith,
  RouteKitFailure,
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
