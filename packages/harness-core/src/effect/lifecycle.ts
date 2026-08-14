import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  SessionResourceRegistry,
  SingleFlightTurnController,
  type TurnLease
} from "../lifecycle.js";

/**
 * Effect façade over harness turn and session lifetime.
 *
 * The one-live-turn rule stays on `SingleFlightTurnController`. Scope close
 * disposes an incomplete lease, which aborts the native operation.
 */
export function scopedTurn(controller: SingleFlightTurnController, external?: AbortSignal) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => controller.start(external),
      catch: (cause) => routeKitError(cause)
    }),
    (lease: TurnLease) => Effect.sync(() => lease.dispose())
  );
}

export function scopedSessionRegistry(registry: SessionResourceRegistry) {
  return Effect.acquireRelease(Effect.succeed(registry), (owned) =>
    Effect.tryPromise({
      try: () => owned.dispose(),
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.ignore)
  );
}
