import { toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { AccountActivityCoordinator } from "../activity.js";

/**
 * Composite request lease: the activity attempt plus any extra finalizers
 * (stream body, capacity, auth probation). Extra finalizers run first so
 * downstream resources release before the serving attempt is marked idle.
 *
 * Selection and failover stay on `SubscriptionRequestExecutor`.
 */
export function scopedRequestLease(input: {
  activity: AccountActivityCoordinator;
  identity: string;
  extras?: readonly (() => void)[];
}) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const releaseAttempt = input.activity.beginAttempt(input.identity);
        return () => {
          for (const extra of input.extras ?? []) extra();
          releaseAttempt();
        };
      },
      catch: toRouteKitFailure
    }),
    (release) => Effect.sync(release)
  );
}
