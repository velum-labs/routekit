import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { startRouter, type RunningRouter, type StartRouterOptions } from "../router.js";

/**
 * Effect façade over router-generation construction.
 *
 * Account-set opening, gateway bind, and ResourceScope transfer stay on
 * `startRouter`. The Effect boundary owns child-scope lifetime so interruption
 * and generation replacement close the live resources exactly once.
 */
export function startRouterEffect(
  options: StartRouterOptions
): Effect.Effect<RunningRouter, Error> {
  return Effect.tryPromise({
    try: () => startRouter(options),
    catch: (cause) => routeKitError(cause)
  });
}

/** Start a router that is closed when the current scope ends. */
export function scopedRouter(options: StartRouterOptions) {
  return Effect.acquireRelease(startRouterEffect(options), (router) =>
    Effect.tryPromise({
      try: () => router.close(),
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.ignore)
  );
}
