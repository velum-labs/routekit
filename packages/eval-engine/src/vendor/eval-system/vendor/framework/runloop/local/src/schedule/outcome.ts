// How a fire's outcome is decided: the same question run history and telemetry
// both answer, kept in one module so the two cannot drift apart again.
import { Cause, Data } from "effect";

import type { ScheduleRunStatus } from "../../../../contracts/internal/src/runtime/schedule-introspection.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/agent-event.ts";
import { ScheduleAgentFailureError } from "./fire.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

export class ScheduleOutcomeError extends Data.TaggedError(
  "ScheduleOutcomeError"
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return formatUnknownError(this.cause);
  }
}

export const classifyScheduleRunOutcome = (
  failed: boolean
): ScheduleRunStatus => (failed ? "error" : "ok");

/**
 * The same rule `observeScheduleEvent` writes history with, so a fire's
 * telemetry and its history row cannot disagree.
 *
 * Not monotonic, for the same reason history is not: a terminal success after a
 * failure means the run recovered, and reporting the recovery as an error
 * inflates the fleet's schedule failure rate with runs that finished. And
 * `runtime.error` is absent from both sides because it is diagnostic and
 * non-terminal. A fire that genuinely failed still reports `error` through the
 * thrown-error arm in `fireAndObserveSchedule`.
 */
export const updateScheduleRunFailure = (input: {
  /** Whether the schedule has its own `run` handler around each invoke. */
  readonly customRun: boolean;
  readonly event: { readonly type: string };
  readonly failed: boolean;
}): boolean => {
  // A custom handler owns the control flow around each invoke and may recover,
  // retry, or deliberately tolerate a failed turn, which is why
  // `fireScheduleOnce` does not fail the fire for one and history records the
  // run as `ok`. Counting that same event as a telemetry failure is exactly the
  // disagreement this module exists to prevent; the handler throwing still
  // reports `error` through the thrown-error arm.
  if (input.customRun) {
    return input.failed;
  }
  if (
    input.event.type === AgentRuntimeEventTag.SessionFailed ||
    input.event.type === AgentRuntimeEventTag.TurnFailed
  ) {
    return true;
  }
  if (
    input.event.type === AgentRuntimeEventTag.SessionSucceeded ||
    input.event.type === AgentRuntimeEventTag.TurnSucceeded
  ) {
    return false;
  }
  return input.failed;
};

// The chain from the runner to the throw runs through two of ROUTEKIT_EVAL's own
// transparent wrappers plus whatever `Effect.runPromise` rejects with in
// between. That middle hop is runtime-internal, so the walk is bounded by a
// cycle guard rather than by a hop count that silently stops being right when
// Effect changes how it wraps a rejection.
const MAX_CAUSE_CHAIN = 32;

/**
 * Whether a fire's rejection is the terminal agent failure `fireAndRecord`
 * already wrote to run history, rather than an unrelated crash that nothing
 * else recorded.
 */
export const isRecordedAgentFailure = (
  cause: Cause.Cause<ScheduleOutcomeError>
): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = Cause.squash(cause);
  while (
    current !== undefined &&
    current !== null &&
    !seen.has(current) &&
    seen.size < MAX_CAUSE_CHAIN
  ) {
    if (current instanceof ScheduleAgentFailureError) {
      return true;
    }
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
};
