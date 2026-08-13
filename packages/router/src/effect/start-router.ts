import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { type StartRouterOptions, startRouterEffect } from "../router.js";

export { startRouterEffect };

/** Start a router that is closed when the current scope ends. */
export function scopedRouter(options: StartRouterOptions) {
  return Effect.acquireRelease(startRouterEffect(options), (router) =>
    Effect.tryPromise({
      try: () => router.close(),
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.ignore)
  );
}
