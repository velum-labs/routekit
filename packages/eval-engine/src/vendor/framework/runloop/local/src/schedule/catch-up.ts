// The durable last-fire record is the newest `ori_schedule_runs` row — no
// separate last-fire store is introduced (RFC 0006 builtin-cron-scheduler.md).
import { Effect, Option } from "effect";

import type { ScheduleDefinition } from "../../../../contracts/author/src/schedule.ts";
import type { ScheduleRunRecord } from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";
import type { ParsedCron } from "./cron.ts";
import type {
  NamedSchedule,
  ScheduleRuntimeShape,
} from "./types.ts";

import { parseCron } from "./cron.ts";
import { HOST_TIMEZONE } from "./host-timezone.ts";
import { latestRunsByScheduleId } from "./run-store.ts";
import { ScheduleRuntime } from "./types.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * Whether a `catchUp` schedule missed at least one fire between its last recorded
 * fire and `now`. True when there exists a cron instant strictly after `lastFiredAt`
 * and at or before `now` — i.e. the runtime was down across a scheduled instant.
 *
 * Pure and side-effect-free so it is unit-testable without a store or timers: it
 * takes an already-parsed {@link ParsedCron} evaluator (parsing is an Effect, kept
 * out of this decision) and:
 * - `lastFiredAt === undefined` (never fired) returns `false` — a first-ever boot
 *   is not a missed window; the schedule simply arms and waits for its next fire.
 * - A calendar-impossible cron (`nextFire` returns `null`) returns `false`.
 *
 * The result is a single boolean regardless of how many instants were missed:
 * catch-up coalesces a gap of N missed fires into one fire (standard cron
 * catch-up semantics), and the next fire stays on the normal cadence.
 */
const missedFireWhileDown = (input: {
  readonly parsed: ParsedCron;
  readonly lastFiredAt: Date | undefined;
  readonly now: Date;
}): boolean => {
  if (input.lastFiredAt === undefined) {
    return false;
  }
  const nextAfterLast = input.parsed.nextFire(input.lastFiredAt);
  if (nextAfterLast === null) {
    return false;
  }
  return nextAfterLast.getTime() <= input.now.getTime();
};

/**
 * The detached fire path {@link catchUpMissedFires} dispatches a missed fire
 * through, as an Effect: it resolves at the first session id (or settle) and its
 * outcome is durably recorded by the runner's `fireAndRecord`. Injected so this
 * module takes no dependency on the firing path.
 */
interface ScheduleFireTarget {
  readonly featureId: string;
  readonly name: string;
  readonly definition: ScheduleDefinition;
  readonly runtime: ScheduleRuntimeShape;
}

type DetachedFire = (
  target: ScheduleFireTarget
) => Effect.Effect<readonly string[], Error>;

/**
 * Parse the schedule's cron (the new Effect `parseCron`) in the same timezone the
 * runner arms it under, then apply the pure {@link missedFireWhileDown} decision.
 * A `CronParseError` (malformed cron / unknown timezone) is `Effect.orElseSucceed`d
 * to "not missed" — an arm-time-invalid expression is reported at arm time and
 * simply does not catch up here.
 */
const missedFireEffect = (
  schedule: NamedSchedule,
  lastFiredAt: Date | undefined,
  now: Date
): Effect.Effect<boolean> =>
  // The runner arms a schedule under this same
  // `schedule.definition.timezone ?? HOST_TIMEZONE` default (schedule-runner.ts);
  // catch-up parses under it too so the missed-window decision matches the
  // cadence the schedule actually fires on.
  parseCron(
    schedule.definition.cron,
    schedule.definition.timezone ?? HOST_TIMEZONE
  ).pipe(
    Effect.map((parsed) =>
      missedFireWhileDown({
        lastFiredAt,
        now,
        parsed,
      })
    ),
    Effect.orElseSucceed(() => false)
  );

/**
 * Fire each `catchUp` schedule that missed a scheduled instant while the runtime
 * was down (RFC 0006 catch-up). The durable last-fire record is the newest
 * `ori_schedule_runs` row, so no separate last-fire store is needed: a single
 * {@link latestRunsByScheduleId} read decides every schedule. Missed fires are
 * forked into the caller's scope (fire-and-forget) so boot never waits on an
 * agent run, and coalesced — a gap of N missed instants produces one fire, after
 * which the normal cron cadence resumes.
 *
 * Best-effort throughout, expressed in Effect rather than `try`/`catch`: the
 * store read falls back to an empty map (`Effect.orElseSucceed`), a `parseCron`
 * `CronParseError` folds to "not missed" (`Effect.orElseSucceed(false)`), and each
 * detached fire is `Effect.ignore`d so one failure never breaks the others or boot.
 *
 * `now` is injected by the runner (the single owner of the wall-clock read) so
 * this module reads no clock of its own and stays unit-testable with a fixed
 * instant. Forking requires the caller's `Scope` (the runner arms schedules in a
 * scoped resource, so the scope is already in context).
 */
export interface CatchUpContext {
  readonly fire: DetachedFire;
  readonly now: Date;
}

export const catchUpMissedFires = Effect.fn("CatchUp.catchUpMissedFires")(
  function* (schedules: readonly NamedSchedule[], context: CatchUpContext) {
    const { fire, now } = context;
    const runtime = yield* ScheduleRuntime;
    // A `disabled` schedule is loaded but never armed on the cron, so it must not
    // catch up either — `disabled` wins over `catchUp` (it is the kill switch).
    const eligible = schedules.filter(
      (schedule) =>
        schedule.definition.catchUp === true &&
        schedule.definition.disabled !== true
    );
    if (eligible.length === 0) {
      return;
    }
    // The logger goes in so a row dropped by the decode leaves a trace: a dropped
    // newest row reads as "never fired" here, which silently suppresses the very
    // catch-up this function exists to perform.
    const latest = yield* latestRunsByScheduleId(
      runtime.store,
      runtime.logger
    ).pipe(Effect.orElseSucceed(() => new Map<string, ScheduleRunRecord>()));
    for (const schedule of eligible) {
      const lastRun = latest.get(schedule.name);
      const lastFiredAt =
        lastRun === undefined ? undefined : new Date(lastRun.firedAt);
      const missed = yield* missedFireEffect(schedule, lastFiredAt, now);
      if (!missed) {
        continue;
      }
      if (Option.isSome(runtime.logger)) {
        runtime.logger.value.debug("schedule catching up a missed fire", {
          scheduleId: schedule.name,
        });
      }
      // Forked into the caller's scope: the fire runs in the background (resolves
      // at the first session id), so a slow agent run never blocks boot. Its
      // outcome is durably recorded by `fireAndRecord`; `Effect.ignore` swallows a
      // failure here so one catch-up fire never breaks the others or boot. A debug
      // breadcrumb is logged first so the swallowed failure is still diagnosable.
      yield* fire({
        definition: schedule.definition,
        featureId: schedule.featureId,
        name: schedule.name,
        runtime,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (Option.isSome(runtime.logger)) {
              runtime.logger.value.debug("schedule catch-up fire failed", {
                error: formatUnknownError(cause),
                scheduleId: schedule.name,
              });
            }
          })
        ),
        Effect.ignore,
        Effect.forkScoped
      );
    }
  }
);

export { missedFireWhileDown };
export type { ScheduleFireTarget, DetachedFire };
