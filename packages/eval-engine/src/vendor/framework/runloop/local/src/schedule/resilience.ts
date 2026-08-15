// Kept side-effect-free so the firing logic in `schedule-runner.ts` stays a thin
// shell over decisions these functions make, and so both can be unit-tested
// without arming real cron timers.
import { Effect, Random } from "effect";

const NO_JITTER_MS = 0;

/**
 * A random startup/fire delay in `[0, maxJitterMs)` that splays schedules sharing
 * a tick. An unset, non-finite, or non-positive bound disables jitter (fire
 * immediately). Randomness comes from the `Random` service rather than
 * `Math.random`, so a test pins it with `Random.withSeed` and production jitter is
 * reproducible under a seeded runtime.
 *
 * The draw is a `[0, 1)` double scaled by hand rather than `Random.nextIntBetween`:
 * that helper floors its bound before drawing, and `jitterMs` accepts fractional
 * values, so a bound in `[1, 2)` would floor to 1 and disable jitter outright.
 */
export const computeJitterDelayMs = (
  maxJitterMs: number | undefined
): Effect.Effect<number> => {
  if (
    maxJitterMs === undefined ||
    !Number.isFinite(maxJitterMs) ||
    maxJitterMs <= NO_JITTER_MS
  ) {
    return Effect.succeed(NO_JITTER_MS);
  }
  return Random.next.pipe(Effect.map((draw) => Math.floor(draw * maxJitterMs)));
};
