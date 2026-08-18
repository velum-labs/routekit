import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { PiKnownSessionEvent } from "../native/schema.ts";

type CompactionEnd = Extract<
  PiKnownSessionEvent,
  { readonly type: "compaction_end" }
>;

// Reuse the schema's Schema.Literals sets (via the decoded compaction variant)
// instead of re-declaring the reason/trigger/cause unions by hand.
type CompactionReason = CompactionEnd["reason"];
type CompactionTrigger = NonNullable<CompactionEnd["oriTrigger"]>;
type CompactionCause = NonNullable<CompactionEnd["oriCause"]>;

const compactionFields = (
  reason: CompactionReason,
  trigger?: CompactionTrigger,
  cause?: CompactionCause
): {
  readonly cause?: CompactionCause;
  readonly trigger: CompactionTrigger;
} => ({
  ...(cause === undefined && reason !== "manual" ? { cause: reason } : {}),
  ...(cause === undefined ? {} : { cause }),
  trigger: trigger ?? (reason === "manual" ? "manual" : "automatic"),
});

const projectCompactionEnd = function* (
  event: CompactionEnd
): Generator<AgentAdapterEvent> {
  const common = compactionFields(
    event.reason,
    event.oriTrigger,
    event.oriCause
  );
  if (event.aborted) {
    yield {
      ...common,
      event: "compaction.cancelled",
    };
    return;
  }
  if (event.result === undefined || event.result === null) {
    yield {
      ...common,
      event: "compaction.failed",
      ...(event.errorMessage === undefined
        ? {}
        : { message: event.errorMessage }),
      ...(event.willRetry === undefined ? {} : { willRetry: event.willRetry }),
    };
    return;
  }
  yield {
    ...common,
    event: "compaction.completed",
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.result.estimatedTokensAfter === undefined
      ? {}
      : { tokensAfter: event.result.estimatedTokensAfter }),
    tokensBefore: event.result.tokensBefore,
    ...(event.willRetry === undefined ? {} : { willRetry: event.willRetry }),
  };
};

/**
 * Projects a decoded Pi session event to ACP observation events (retry and
 * compaction). Yields nothing when the event is not an observation, so the
 * projector can concatenate this arm with the session-update arm.
 *
 * @yields {AgentAdapterEvent} each ACP observation event (retry, compaction).
 */
const projectPiObservation = function* (
  event: PiKnownSessionEvent
): Generator<AgentAdapterEvent> {
  const { guards } = PiKnownSessionEvent;
  if (guards.auto_retry_start(event)) {
    yield {
      attempt: event.attempt,
      delayMs: event.delayMs,
      event: "retry.scheduled",
      maxAttempts: event.maxAttempts,
      ...(event.errorMessage === undefined
        ? {}
        : { message: event.errorMessage }),
    };
    return;
  }
  if (guards.auto_retry_end(event)) {
    yield event.success
      ? {
          attempt: event.attempt,
          event: "retry.completed",
        }
      : {
          attempt: event.attempt,
          event: "retry.failed",
          ...(event.finalError === undefined
            ? {}
            : { message: event.finalError }),
        };
    return;
  }
  if (guards.compaction_start(event)) {
    yield {
      ...compactionFields(event.reason, event.oriTrigger, event.oriCause),
      event: "compaction.started",
    };
    return;
  }
  if (guards.compaction_end(event)) {
    yield* projectCompactionEnd(event);
  }
};

export { projectPiObservation };
