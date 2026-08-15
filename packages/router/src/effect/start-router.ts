import { Effect } from "effect";

import { type StartRouterOptions, startRouterEffect } from "../router.js";

export { startRouterEffect };

/** Start a router that is closed when the current scope ends. */
export function scopedRouter(options: StartRouterOptions) {
  return Effect.acquireRelease(startRouterEffect(options), (router) =>
    router.close.pipe(Effect.ignore)
  );
}
