import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Context, Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { throwRouteKitExit } from "./errors.js";

/**
 * Process-lifetime platform layer: Node filesystem/path/process services plus
 * the Fetch-backed HttpClient used for outbound calls.
 *
 * `Fetch` always delegates to the current `globalThis.fetch` so tests that stub
 * fetch are observed. Effect's default Fetch reference caches the first
 * function it sees.
 */
const liveFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export const RouteKitLive = Layer.mergeAll(
  nodeServicesLayer,
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeedContext(Context.make(FetchHttpClient.Fetch, liveFetch)))
  )
);

/** The platform services available to a RouteKit Effect runtime. */
export type RouteKitPlatform = Layer.Success<typeof RouteKitLive>;

/** A managed runtime built once and reused for many Effect programs. */
export type RouteKitManagedRuntime = ManagedRuntime.ManagedRuntime<RouteKitPlatform, never>;

let sharedRuntime: RouteKitManagedRuntime | undefined;

/**
 * Build a Node-backed RouteKit runtime.
 *
 * Prefer {@link sharedRouteKitRuntime} at process entries. Only construct a
 * fresh runtime when the caller needs an isolated lifetime (tests that dispose).
 */
export function makeRouteKitRuntime(): RouteKitManagedRuntime {
  return ManagedRuntime.make(RouteKitLive);
}

/**
 * Process-lifetime runtime. Never disposed per request — outbound streams keep
 * the Fetch HttpClient alive until the process exits or the caller disposes.
 */
export function sharedRouteKitRuntime(): RouteKitManagedRuntime {
  sharedRuntime ??= makeRouteKitRuntime();
  return sharedRuntime;
}

/**
 * Run a program, reusing `runtime` or the process-lifetime runtime.
 *
 * RouteKitLive provides the platform services. This runner does not constrain
 * `R` to `RouteKitPlatform` because Effect 4 encodes `yield* HttpClient` as
 * `Request<"Requires", HttpClient>`, which is not a subtype of the platform
 * union. Unmet services still fail when the program runs.
 */
export async function runRouteKitEffect<A, E, R = RouteKitPlatform>(
  effect: Effect.Effect<A, E, R>,
  runtime?: RouteKitManagedRuntime
): Promise<A> {
  const exit = await (runtime ?? sharedRouteKitRuntime()).runPromiseExit(
    effect as Effect.Effect<A, E, RouteKitPlatform>
  );
  return throwRouteKitExit(exit);
}

/**
 * Run a program on an already-captured fiber context.
 *
 * Use this at Promise-shaped product edges (generation persist, gateway usage,
 * timers, dialect relays) instead of constructing a nested ManagedRuntime.
 */
export async function runRouteKitEffectWith<A, E, Provided, R extends Provided = Provided>(
  context: Context.Context<Provided>,
  effect: Effect.Effect<A, E, R>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(context)));
  return throwRouteKitExit(exit);
}

/**
 * Run an Effect on a captured fiber context.
 *
 * Promise-shaped product edges (timers, dialect relays, backend HTTP) must not
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

/** Run a program and retain its full Effect exit for boundary translation. */
export async function runRouteKitEffectExit<A, E, R = RouteKitPlatform>(
  effect: Effect.Effect<A, E, R>,
  runtime?: RouteKitManagedRuntime
): Promise<Exit.Exit<A, E>> {
  return await (runtime ?? sharedRouteKitRuntime()).runPromiseExit(
    effect as Effect.Effect<A, E, RouteKitPlatform>
  );
}
