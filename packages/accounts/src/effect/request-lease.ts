import { Effect } from "effect";

import { EffectAccountActivityCoordinator } from "./activity.js";

/**
 * Composite request lease: the activity attempt plus any extra finalizers
 * (stream body, capacity, auth probation). Extra finalizers run first so
 * downstream resources release before the serving attempt is marked idle.
 *
 * Selection and failover stay on `SubscriptionRequestExecutor`.
 */
export function scopedRequestLease(input: {
  activity: EffectAccountActivityCoordinator;
  identity: string;
  extras?: readonly (() => void)[];
}) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const releaseAttempt = yield* input.activity.beginAttempt(input.identity);
      return () => {
        for (const extra of input.extras ?? []) extra();
        releaseAttempt();
      };
    }),
    (release) => Effect.sync(release)
  );
}
