import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { layer as fetchHttpClientLayer } from "effect/unstable/http/FetchHttpClient";

const routeKitLayer = Layer.mergeAll(nodeServicesLayer, fetchHttpClientLayer);

/** The platform services available to a RouteKit Effect runtime. */
export type RouteKitPlatform = Layer.Success<typeof routeKitLayer>;

/** A managed runtime built once and reused for many Effect programs. */
export type RouteKitManagedRuntime = ManagedRuntime.ManagedRuntime<RouteKitPlatform, never>;

/**
 * Build the default Node-backed RouteKit runtime.
 *
 * Construct one runtime per daemon, CLI invocation, or embedded host and reuse
 * it. Do not construct-and-dispose a runtime per request.
 */
export function makeRouteKitRuntime(): RouteKitManagedRuntime {
  return ManagedRuntime.make(routeKitLayer);
}

/** Run a program, reusing `runtime` when the caller already owns one. */
export async function runRouteKitEffect<A, E, R extends RouteKitPlatform = RouteKitPlatform>(
  effect: Effect.Effect<A, E, R>,
  runtime?: RouteKitManagedRuntime
): Promise<A> {
  if (runtime !== undefined) return await runtime.runPromise(effect);
  const owned = makeRouteKitRuntime();
  try {
    return await owned.runPromise(effect);
  } finally {
    await owned.dispose();
  }
}

/** Run a program and retain its full Effect exit for boundary translation. */
export async function runRouteKitEffectExit<A, E, R extends RouteKitPlatform = RouteKitPlatform>(
  effect: Effect.Effect<A, E, R>,
  runtime?: RouteKitManagedRuntime
): Promise<Exit.Exit<A, E>> {
  if (runtime !== undefined) return await runtime.runPromiseExit(effect);
  const owned = makeRouteKitRuntime();
  try {
    return await owned.runPromiseExit(effect);
  } finally {
    await owned.dispose();
  }
}
