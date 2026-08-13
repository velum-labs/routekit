import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  cleanupFailedDaemon,
  createDaemonLifecycle,
  type DaemonLifecycleOptions
} from "../daemon-lifecycle.js";

/**
 * Effect façade over ordinary daemon root-scope shutdown.
 *
 * LIFO ResourceScope teardown, drain vs retire, and SIGHUP stay on
 * `createDaemonLifecycle`. This adapter owns interruption at the Effect
 * boundary without changing shutdown order.
 */
export function createDaemonLifecycleEffect(options: DaemonLifecycleOptions) {
  const lifecycle = createDaemonLifecycle(options);
  return {
    inner: lifecycle,
    close(): Effect.Effect<void, Error> {
      return Effect.tryPromise({
        try: () => lifecycle.close(),
        catch: (cause) => routeKitError(cause)
      });
    },
    retire(graceMs?: number): Effect.Effect<void, Error> {
      return Effect.tryPromise({
        try: () => lifecycle.retire(graceMs),
        catch: (cause) => routeKitError(cause)
      });
    },
    pauseMutations(): Effect.Effect<ReturnType<typeof lifecycle.snapshot>, Error> {
      return Effect.tryPromise({
        try: () => lifecycle.pauseMutations(),
        catch: (cause) => routeKitError(cause)
      });
    },
    resumeMutations(): Effect.Effect<void> {
      return Effect.sync(() => {
        lifecycle.resumeMutations();
      });
    },
    snapshot(): Effect.Effect<ReturnType<typeof lifecycle.snapshot>> {
      return Effect.sync(() => lifecycle.snapshot());
    },
    reload(): Effect.Effect<void, Error> {
      return Effect.tryPromise({
        try: () => lifecycle.reload(),
        catch: (cause) => routeKitError(cause)
      });
    }
  };
}

export function cleanupFailedDaemonEffect(
  input: Parameters<typeof cleanupFailedDaemon>[0]
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => cleanupFailedDaemon(input),
    catch: (cause) => routeKitError(cause)
  });
}
