import { Data, Effect } from "effect";

import { SessionResourceRegistry, SingleFlightTurnController } from "../lifecycle.js";

/**
 * Effect façade over harness turn and session lifetime.
 */
export function scopedTurn(controller: SingleFlightTurnController, external?: AbortSignal) {
  return controller.lease(external);
}

export class SessionRegistryDisposeError extends Data.TaggedError("SessionRegistryDisposeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export function scopedSessionRegistry(registry: SessionResourceRegistry) {
  return Effect.acquireRelease(Effect.succeed(registry), (owned) =>
    Effect.tryPromise({
      try: () => owned.dispose(),
      catch: (cause) =>
        new SessionRegistryDisposeError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause
        })
    }).pipe(Effect.ignore)
  );
}
