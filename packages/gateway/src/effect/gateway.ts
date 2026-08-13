import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { startGateway, type Gateway, type GatewayOptions } from "../server.js";

/**
 * Effect façade over gateway HTTP ownership.
 *
 * Bind, auth, and streaming stay on `startGateway`. The Effect scope owns the
 * listener so interruption closes the server before a leaked stream can outlive
 * the generation.
 */
export function startGatewayEffect(options: GatewayOptions): Effect.Effect<Gateway, Error> {
  return Effect.tryPromise({
    try: () => startGateway(options),
    catch: (cause) => routeKitError(cause)
  });
}

export function scopedGateway(options: GatewayOptions) {
  return Effect.acquireRelease(startGatewayEffect(options), (gateway) =>
    Effect.tryPromise({
      try: () => gateway.close(),
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.ignore)
  );
}
