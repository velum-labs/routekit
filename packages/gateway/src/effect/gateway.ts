import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { type GatewayOptions, startGateway } from "../server.js";

/** Run a synchronous gateway step as an Effect, preserving Error subclasses. */
export function gatewayTry<A>(run: () => A): Effect.Effect<A, Error> {
  return Effect.try({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : routeKitError(cause))
  });
}

/** Run an asynchronous gateway step as an Effect, preserving Error subclasses. */
export function gatewayTryPromise<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : routeKitError(cause))
  });
}

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
      catch: (cause) => routeKitError(cause)
    }),
    (gateway) =>
      Effect.tryPromise({
        try: () => gateway.close(),
        catch: (cause) => routeKitError(cause)
      }).pipe(Effect.ignore)
  );
}
