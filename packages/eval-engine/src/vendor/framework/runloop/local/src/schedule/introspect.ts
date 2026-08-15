import { Effect } from "effect";

import type { ScheduleDefinition } from "../../../../contracts/author/src/schedule.ts";
import type {
  ScheduleMode,
  ScheduleRunRecord,
  ScheduleSummary,
} from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";

import { parseCron } from "./cron.ts";
import { HOST_TIMEZONE } from "./host-timezone.ts";

/**
 * A schedule definition paired with its registry name: the owning feature id for
 * the feature-named schedule, or the nested folder name for a
 * `schedules/<name>/schedule.{ts,md}` entry (RFC 0002 schedule.md).
 */
interface NamedScheduleDefinition {
  readonly definition: ScheduleDefinition;
  readonly name: string;
}

const scheduleMode = (definition: ScheduleDefinition): ScheduleMode =>
  definition.run === undefined ? "markdown" : "run";

// A malformed cron (CronParseError) sinks to `null`, same as a valid-but-never-
// fires expression, so it sorts to the bottom rather than breaking the listing.
const computeNextFireAt = (
  definition: ScheduleDefinition,
  now: number,
  timezone: string
): Effect.Effect<string | null> =>
  parseCron(definition.cron, timezone).pipe(
    Effect.map(
      (parsed) => parsed.nextFire(new Date(now))?.toISOString() ?? null
    ),
    Effect.orElseSucceed(() => null)
  );

/**
 * Build a schedule summary: its cron/timezone, the mode it fires in, the next
 * fire computed from the cron, and its most recent run (RFC 0002 schedule.md). `nextFireAt`
 * is `null` when the cron has no upcoming fire or fails to parse.
 */
const buildScheduleSummary = Effect.fn("ScheduleIntrospection.buildSummary")(
  function* (
    entry: NamedScheduleDefinition,
    now: number,
    lastRun?: ScheduleRunRecord
  ) {
    const timezone = entry.definition.timezone ?? HOST_TIMEZONE;
    // A disabled schedule is never armed, so it has no next fire — report `null`
    // rather than a phantom time that would never actually trigger.
    const disabled = entry.definition.disabled === true;
    const nextFireAt = disabled
      ? null
      : yield* computeNextFireAt(entry.definition, now, timezone);
    // Omit `lastRun` entirely when there is no run, rather than emitting a
    // present-but-`undefined` key: the response schema declares it `optionalKey`,
    // and a present-undefined value is wider than that schema `.Type` under
    // `exactOptionalPropertyTypes`. The wire JSON is identical either way.
    return {
      cron: entry.definition.cron,
      disabled,
      mode: scheduleMode(entry.definition),
      name: entry.name,
      nextFireAt,
      timezone,
      ...(lastRun === undefined ? {} : { lastRun }),
    };
  }
);

// ISO-8601 instants sort lexicographically in chronological order; null (no
// upcoming fire) sinks to the bottom, ties broken by name for a stable order.
const compareByNextFire = (a: ScheduleSummary, b: ScheduleSummary): number => {
  if (a.nextFireAt === b.nextFireAt) {
    return a.name.localeCompare(b.name);
  }
  if (a.nextFireAt === null) {
    return 1;
  }
  if (b.nextFireAt === null) {
    return -1;
  }
  return a.nextFireAt.localeCompare(b.nextFireAt);
};

/** Summaries for every schedule, soonest next fire first (schedules with no upcoming fire last). */
export const buildScheduleSummaries = Effect.fn(
  "ScheduleIntrospection.buildSummaries"
)(function* (
  entries: readonly NamedScheduleDefinition[],
  now: number,
  lastRuns: ReadonlyMap<string, ScheduleRunRecord>
) {
  const summaries = yield* Effect.all(
    entries.map((entry) =>
      buildScheduleSummary(entry, now, lastRuns.get(entry.name))
    )
  );
  return summaries.toSorted(compareByNextFire);
});

export { buildScheduleSummary };
export type { NamedScheduleDefinition };
