import { Effect } from "effect";

import { type GatewayOptions, startGatewayEffect } from "../gateway-service.js";

/**
 * Own a gateway listener for the current Effect scope.
 *
 * The scope closes the listener on interruption so a leaked stream cannot
 * outlive the generation.
 */
export function scopedGateway(options: GatewayOptions) {
  return Effect.acquireRelease(startGatewayEffect(options), (gateway) =>
    gateway.close.pipe(Effect.ignore)
  );
}
