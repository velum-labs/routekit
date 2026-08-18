import { Effect } from "effect";

import { extendCleanupGrace, registerCleanup, runCleanups } from "./cleanup.js";
import { runRouteKitEffect } from "../effect/effect-runtime.js";
import { toRouteKitFailure } from "../effect/errors.js";

/**
 * Register an Effect teardown callback on RouteKit's process-wide cleanup
 * registry. The unregister function is idempotent, matching `registerCleanup`.
 *
 * Signal handling, LIFO order, the hard shutdown bound, and conventional
 * SIGINT/SIGTERM exit codes stay on the existing registry. This adapter does
 * not replace those semantics with Effect's process layer.
 */
export function registerCleanupEffect(
  finalizer: Effect.Effect<void, unknown>
): Effect.Effect<() => void> {
  return Effect.sync(() => registerCleanup(() => runRouteKitEffect(finalizer)));
}

/** Run registered cleanups once. A second call is a no-op. */
export const runCleanupsEffect: Effect.Effect<void, unknown> = Effect.tryPromise({
  try: () => runCleanups(),
  catch: (cause) => toRouteKitFailure(cause)
});

/** Raise (never lower) the process-wide cleanup shutdown bound. */
export function extendCleanupGraceEffect(ms: number): Effect.Effect<void> {
  return Effect.sync(() => {
    extendCleanupGrace(ms);
  });
}
