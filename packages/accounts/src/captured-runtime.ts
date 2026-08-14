import {
  type RouteKitPlatform,
  runRouteKitEffect,
  runRouteKitEffectWith
} from "@velum-labs/routekit-runtime/effect";
import type { Context, Effect } from "effect";

/**
 * Run an Effect on a captured fiber context.
 *
 * Promise-shaped product edges (timers, dialect relays, asyncDispose) must not
 * construct a nested ManagedRuntime. Callers that were not opened from Effect
 * fall back to the process-lifetime runtime.
 */
export function runCapturedPlatform<A, E, R>(
  platform: Context.Context<RouteKitPlatform> | undefined,
  effect: Effect.Effect<A, E, R>
): Promise<A> {
  return platform === undefined
    ? runRouteKitEffect(effect as Effect.Effect<A, E, RouteKitPlatform>)
    : runRouteKitEffectWith(platform, effect as Effect.Effect<A, E, RouteKitPlatform>);
}
