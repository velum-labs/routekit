// The cron cadence for one schedule, as an Effect `Schedule`. Kept out of
// `schedule-runner.ts` so the queue branch is unit-testable under `TestClock`
// without a runtime: the runner's fire path is Promise-based, so a test cannot
// make a real fire overrun on a virtual clock.
// `Cron` is a type-only use here; a value import trips
// `typescript(consistent-type-imports)` at `check`.
import type { Cron } from "effect";

import { Cause, Duration, Effect, Schedule } from "effect";

import type { ScheduleOverlapPolicy } from "../../../../contracts/author/src/schedule.ts";
import type { ParsedCron } from "./cron.ts";

/**
 * The recurrence for one schedule.
 *
 * The default (`skip`) is `Schedule.cron`, which steps from the live clock each
 * recurrence. Awaiting the fire before the next step gives the overrun protection
 * ROUTEKIT_EVAL has always had: a fire that runs past its next tick skips the tick(s) it
 * missed rather than queuing overlapping fires. The cadence stays DST-correct and
 * never holds a timer past `setTimeout`'s ~24.8 day ceiling.
 *
 * `queue` steps from the previous *scheduled* instant instead, so ticks missed
 * while a fire overran run back-to-back (serialized by the single fire fiber)
 * rather than being dropped. `Schedule.cron` cannot express this — it always
 * steps from `now` — so this branch is built from `Schedule.fromStep`, which is
 * what `Schedule.cron` itself is built from.
 *
 * The branches differ on a cron whose candidate search is exhausted: `queue` ends
 * with `Cause.done`, while `Schedule.cron` lets `Cron.next`'s throw become a die.
 * `armSchedule` rejects such a schedule before forking, so neither path is
 * reachable from a live schedule.
 */
export const cronCadence = (
  overlap: ScheduleOverlapPolicy | undefined,
  parsed: ParsedCron
): Schedule.Schedule<Duration.Duration, unknown, Cron.CronParseError> => {
  if (overlap !== "queue") {
    return Schedule.cron(parsed.cron);
  }
  return Schedule.fromStep(
    Effect.sync(() => {
      let lastTick: Date | undefined;
      return (now: number) => {
        // `TestClock`'s drain-everything sentinel, mirroring `Schedule.cron`'s
        // own guard: end the schedule rather than compute a tick from infinity.
        if (now === Number.POSITIVE_INFINITY) {
          return Cause.done(Duration.zero);
        }
        const next = parsed.nextFire(lastTick ?? new Date(now));
        // A calendar-impossible cron has no upcoming fire; end the schedule
        // instead of sleeping forever.
        if (next === null) {
          return Cause.done(Duration.zero);
        }
        lastTick = next;
        // Clamped at zero: when a fire overran past this tick, run it now.
        const delay = Duration.millis(Math.max(next.getTime() - now, 0));
        return Effect.succeed<[Duration.Duration, Duration.Duration]>([
          delay,
          delay,
        ]);
      };
    })
  );
};
