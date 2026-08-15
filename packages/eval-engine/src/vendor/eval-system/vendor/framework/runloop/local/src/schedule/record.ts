import { Effect, Option } from "effect";

import type { AgentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import type { ScheduleRunRecord } from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";
import type { ScheduleRuntimeShape } from "./types.ts";

import { agentFailure } from "../../../../contracts/author/src/errors/agent-failure.ts";
import { recordScheduleRun } from "./run-store.ts";
import { formatSafeErrorDiagnostic } from "../../../../utils/core/src/error-formatting.ts";

// Run-history persistence is best-effort: `Effect.ignore` swallows a write
// failure so it never breaks or masks a fire. A debug breadcrumb is logged
// first so the swallowed write failure stays diagnosable.
const recordRun = (
  runtime: ScheduleRuntimeShape,
  record: ScheduleRunRecord
): Effect.Effect<void> =>
  recordScheduleRun(runtime.store, record).pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => {
        if (Option.isSome(runtime.logger)) {
          runtime.logger.value.debug("schedule run-history write failed", {
            error: cause.message,
            scheduleId: record.scheduleId,
            status: record.status,
          });
        }
      })
    ),
    Effect.ignore
  );

/**
 * Elapsed wall-clock time for a fire, as a non-negative integer.
 *
 * `now` reads a wall clock, which can step backwards across an NTP correction, so
 * a raw subtraction can go negative. `ScheduleRunRecordSchema` declares
 * `durationMs` non-negative (an elapsed measurement cannot be less than zero) and
 * the run-store read enforces it, so a negative value here would be written and
 * then dropped on read. Clamping keeps the write and the read agreeing.
 */
const elapsedMs = (now: () => number, startedAt: number): number =>
  Math.max(0, Math.trunc(now() - startedAt));

/** Persist a successful fire to run history and log a completion breadcrumb. */
export const recordFireOutcome = (input: {
  readonly firedAt: string;
  readonly name: string;
  readonly now: () => number;
  readonly runtime: ScheduleRuntimeShape;
  readonly sessionIds: readonly string[];
  readonly startedAt: number;
}): Effect.Effect<void> => {
  // Measured once and shared with the breadcrumb: reading the clock again there
  // would log a different number under the same `durationMs` name as the one just
  // persisted.
  const durationMs = elapsedMs(input.now, input.startedAt);
  return recordRun(input.runtime, {
    durationMs,
    firedAt: input.firedAt,
    scheduleId: input.name,
    sessionIds: input.sessionIds,
    status: "ok",
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        if (Option.isSome(input.runtime.logger)) {
          input.runtime.logger.value.debug("schedule fire completed", {
            durationMs,
            scheduleId: input.name,
            sessionCount: input.sessionIds.length,
          });
        }
      })
    )
  );
};

/** Persist a failed fire to run history and log the failure breadcrumb. */
export const recordFireFailure = (input: {
  readonly error: unknown;
  readonly failure?: AgentFailure | undefined;
  readonly firedAt: string;
  readonly name: string;
  readonly now: () => number;
  readonly runtime: ScheduleRuntimeShape;
  readonly sessionIds?: readonly string[] | undefined;
  readonly startedAt: number;
}): Effect.Effect<void> => {
  const durationMs = elapsedMs(input.now, input.startedAt);
  // A fire that failed outside the agent stream (a custom `run` that threw, an
  // /api/invoke connection failure, an MCP resolution error) has no structured
  // failure, and this row is the only durable record of it: a detached cron
  // fire's logs may have rotated by the time anyone asks. The thrown error is
  // rendered through the safe formatter rather than dropped for a placeholder,
  // which would answer "why did last night's run fail" with nothing.
  const failure =
    input.failure ??
    agentFailure({
      code: "ROUTEKIT_EVAL_SCHEDULE_FIRE_FAILED",
      message: `The schedule fire failed before ROUTEKIT_EVAL received a structured agent failure: ${formatSafeErrorDiagnostic(input.error)}`,
      remediation: "Check the ROUTEKIT_EVAL logs for the underlying error.",
      stage: "runtime",
    });
  return recordRun(input.runtime, {
    durationMs,
    failure,
    firedAt: input.firedAt,
    scheduleId: input.name,
    sessionIds: input.sessionIds ?? [],
    status: "error",
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        if (Option.isSome(input.runtime.logger)) {
          input.runtime.logger.value.error(
            "schedule fire failed",
            input.error,
            {
              durationMs,
              scheduleId: input.name,
            }
          );
        }
      })
    )
  );
};
