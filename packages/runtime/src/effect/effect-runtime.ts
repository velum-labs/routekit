import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";

/** The platform services available to a RouteKit Effect runtime. */
export type RouteKitPlatform = Layer.Success<typeof nodeServicesLayer>;

/** A managed runtime built once and reused for many Effect programs. */
export type RouteKitManagedRuntime = ManagedRuntime.ManagedRuntime<RouteKitPlatform, never>;

/** Build the default Node-backed RouteKit runtime. */
export function makeRouteKitRuntime(): RouteKitManagedRuntime {
  return ManagedRuntime.make(nodeServicesLayer);
}

/** Run a program against the default Node platform services. */
export async function runRouteKitEffect<A, E>(
  effect: Effect.Effect<A, E, RouteKitPlatform>
): Promise<A> {
  const runtime = makeRouteKitRuntime();
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

/** Run a program and retain its full Effect exit for boundary translation. */
export async function runRouteKitEffectExit<A, E>(
  effect: Effect.Effect<A, E, RouteKitPlatform>
): Promise<Exit.Exit<A, E>> {
  const runtime = makeRouteKitRuntime();
  try {
    return await runtime.runPromiseExit(effect);
  } finally {
    await runtime.dispose();
  }
}
