import { routeKitError } from "@velum-labs/routekit-runtime/effect";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { Effect } from "effect";

import {
  SubscriptionAccountSet,
  type SubscriptionAccountSetOptions
} from "../account-set.js";
import type { SubscriptionProvider } from "../provider.js";

export function openSubscriptionAccountSet<M extends SubscriptionMode>(
  provider: SubscriptionProvider<M>,
  options: SubscriptionAccountSetOptions = {}
) {
  return SubscriptionAccountSet.open(provider, options);
}

/**
 * Open an account set that is closed exactly once when the current scope
 * ends, including on interruption. Probe fibers are torn down by `close()`.
 */
export function scopedSubscriptionAccountSet<M extends SubscriptionMode>(
  provider: SubscriptionProvider<M>,
  options: SubscriptionAccountSetOptions = {}
) {
  return Effect.acquireRelease(SubscriptionAccountSet.open(provider, options), (accountSet) =>
    Effect.tryPromise({
      try: () => accountSet.close(),
      catch: (cause) => routeKitError(cause)
    }).pipe(Effect.ignore)
  );
}
