import { Schema } from "effect";

import { AgentFailureSchema } from "../author-schemas/agent-runtime-event.ts";

import { NonNegativeInt } from "./schema-primitives.ts";

// Every producer here writes `Date#toISOString` output (`schedule-runner-fire.ts`
// stamps `new Date(startedAt).toISOString()`), which always carries exactly three
// fractional digits. The read is deliberately a little wider: second precision and
// 1-2 fractional digits are unambiguous UTC instants too, and a run row may have
// been written by an older build or another tool. What it will NOT accept is a
// local offset (a different point in time than the same digits in UTC) or a
// date-only value. The pattern alone is not enough — it admits calendar-impossible
// dates like month 99 — so `Date.parse` gates the value too.
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/**
 * An ISO-8601 UTC instant: `YYYY-MM-DDTHH:MM:SS[.sss]Z`, and a real calendar date.
 *
 * Checked rather than left a bare `Schema.String` because consumers do date
 * arithmetic on it: schedule catch-up feeds `firedAt` straight to `new Date(...)`
 * and then to the cron evaluator, which throws on an unparseable instant. The
 * arbitrary `candidate` hint keeps the schema fuzzable — the base string
 * generator almost never produces a valid instant on its own.
 */
const IsoInstant = Schema.String.check(
  // `isPattern` rather than testing the RegExp inside the filter: it carries the
  // pattern into the generated JSON Schema and into the base string generator's
  // `patterns` hint, which a hand-rolled `.test()` throws away.
  Schema.isPattern(ISO_INSTANT_PATTERN),
  Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)), {
    arbitrary: {
      candidate: {
        // Bounded to years the pattern can actually match. `fc.date` defaults to
        // roughly ±271821, and an out-of-4-digit year renders as the extended
        // form (`+110841-06-17T...`), which fails the pattern: unbounded, ~86% of
        // draws are discarded and the surviving corpus collapses to a few hundred
        // distinct values clustered at the epoch.
        make: (fc) =>
          fc
            .date({
              max: new Date("9999-12-31T23:59:59.999Z"),
              min: new Date("1000-01-01T00:00:00.000Z"),
              noInvalidDate: true,
            })
            .map((date) => date.toISOString()),
        weight: 20,
      },
    },
    expected: "a real calendar instant",
  })
).annotate({ identifier: "IsoInstant" });

/** Whether a recorded schedule fire succeeded or threw (RFC 0002 schedule.md). */
const ScheduleRunStatusSchema = Schema.Literals(["ok", "error"]);

/** Whether a schedule fires a `markdown` prompt or a custom `run` handler (RFC 0002 schedule.md). */
const ScheduleModeSchema = Schema.Literals(["markdown", "run"]);

/**
 * Fields every recorded fire carries, whatever its outcome.
 *
 * Exported so a consumer that persists or reads these columns can reuse the field
 * schemas instead of re-declaring them (see the run store's row schema). Reusing
 * them is what keeps the snake_case storage row and this contract from drifting.
 *
 * `durationMs` is a wall-clock elapsed measurement (`now() - startedAt`), so it is
 * a non-negative integer: `NaN` and `Infinity` are not JSON values and would fail
 * this schema's own decode after a round trip through the wire.
 */
const scheduleRunFields = {
  durationMs: NonNegativeInt,
  /** ISO-8601 instant the fire began. */
  firedAt: IsoInstant,
  scheduleId: Schema.String,
  /** Session ids the fire started (empty for a `run` handler that never invokes). */
  sessionIds: Schema.Array(Schema.String),
};

/**
 * A durable record of one schedule fire. Written by the runtime on every cron or
 * dev-dispatch fire and read back by the introspection endpoints (RFC 0002 schedule.md).
 */
const ScheduleRunRecordSchema = Schema.Union([
  Schema.Struct({
    ...scheduleRunFields,
    status: Schema.Literal("ok"),
  }),
  Schema.Struct({
    ...scheduleRunFields,
    failure: AgentFailureSchema,
    status: Schema.Literal("error"),
  }),
]).pipe(Schema.toTaggedUnion("status"));

/**
 * A schedule plus its computed next fire and most recent run, as returned by
 * `GET /api/schedules` (RFC 0002 schedule.md, RFC 0008).
 */
const ScheduleSummarySchema = Schema.Struct({
  cron: Schema.String,
  /** Whether the schedule is held off the cron. `true` schedules load but never auto-fire. */
  disabled: Schema.Boolean,
  /**
   * Most recent run, absent when the schedule has never fired. `optionalKey`
   * rather than `optional`, so the key is omitted instead of present-and-undefined,
   * matching the HttpApi success channel's decoded shape.
   */
  lastRun: Schema.optionalKey(ScheduleRunRecordSchema),
  mode: ScheduleModeSchema,
  /** Registry name, always the owning feature id. */
  name: Schema.String,
  /**
   * ISO-8601 next fire, or `null` when the cron has no upcoming fire, fails to
   * parse, or the schedule is disabled (a disabled schedule is never armed, so it
   * has no next fire).
   */
  nextFireAt: Schema.NullOr(IsoInstant),
  timezone: Schema.String,
});

/** `GET /api/schedules` body: every schedule, soonest next fire first (RFC 0008). */
const SchedulesResponseSchema = Schema.Struct({
  schedules: Schema.Array(ScheduleSummarySchema),
});

/** `GET /api/schedules/:name/runs` body: a schedule's recent fires, newest first (RFC 0008). */
const ScheduleRunsResponseSchema = Schema.Struct({
  runs: Schema.Array(ScheduleRunRecordSchema),
  scheduleId: Schema.String,
});

/** `GET /api/schedules/:name` body: one schedule plus its recent runs (RFC 0008). */
const ScheduleDetailResponseSchema = Schema.Struct({
  runs: Schema.Array(ScheduleRunRecordSchema),
  schedule: ScheduleSummarySchema,
});

/**
 * `POST /api/dev/schedules/:name` body: the schedule that fired and the session
 * id(s) the fire started (RFC 0008). The dev-only dispatch route returns this so
 * a developer can subscribe to each started session's events.
 */
const ScheduleDispatchResponseSchema = Schema.Struct({
  scheduleId: Schema.String,
  sessionIds: Schema.Array(Schema.String),
});

type ScheduleRunStatus = typeof ScheduleRunStatusSchema.Type;
type ScheduleMode = typeof ScheduleModeSchema.Type;
type ScheduleRunRecord = typeof ScheduleRunRecordSchema.Type;
type ScheduleSummary = typeof ScheduleSummarySchema.Type;
type SchedulesResponse = typeof SchedulesResponseSchema.Type;
type ScheduleRunsResponse = typeof ScheduleRunsResponseSchema.Type;
type ScheduleDetailResponse = typeof ScheduleDetailResponseSchema.Type;
type ScheduleDispatchResponse = typeof ScheduleDispatchResponseSchema.Type;

export {
  IsoInstant,
  scheduleRunFields,
  ScheduleRunStatusSchema,
  ScheduleModeSchema,
  ScheduleRunRecordSchema,
  ScheduleSummarySchema,
  SchedulesResponseSchema,
  ScheduleRunsResponseSchema,
  ScheduleDetailResponseSchema,
  ScheduleDispatchResponseSchema,
};
export type {
  ScheduleRunStatus,
  ScheduleMode,
  ScheduleRunRecord,
  ScheduleSummary,
  SchedulesResponse,
  ScheduleRunsResponse,
  ScheduleDetailResponse,
  ScheduleDispatchResponse,
};
