import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { type Context, Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

export { runCapturedPlatform } from "@velum-labs/routekit-runtime/effect";

/**
 * Provide a captured RouteKit platform onto a program and type the remainder
 * as `HttpClient`. When `platform` is set, `Effect.provide` satisfies Node/file
 * services at this boundary; the gateway later provides the request-scoped
 * HttpClient.
 */
export function provideCapturedPlatform<A, E, R>(
  platform: Context.Context<RouteKitPlatform> | undefined,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Error, HttpClient.HttpClient> {
  return (platform === undefined ? effect : Effect.provide(effect, platform)) as Effect.Effect<
    A,
    Error,
    HttpClient.HttpClient
  >;
}
