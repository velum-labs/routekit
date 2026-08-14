import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { type GatewayOptions, startGateway } from "../server.js";

/**
 * Own a gateway listener for the current Effect scope.
 *
 * Bind, auth, and streaming stay on Promise `startGateway` (Node HTTP bind
 * edge). The scope closes the listener on interruption so a leaked stream
 * cannot outlive the generation.
 */
export function scopedGateway(options: GatewayOptions) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startGateway(options),
      catch: (cause) => toRouteKitFailure(cause)
    }),
    (gateway) =>
      Effect.tryPromise({
        try: () => gateway.close(),
        catch: (cause) => toRouteKitFailure(cause)
      }).pipe(Effect.ignore)
  );
}
