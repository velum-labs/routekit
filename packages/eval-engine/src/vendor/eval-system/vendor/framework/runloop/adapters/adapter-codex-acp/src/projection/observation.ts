import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { CodexKnownSessionEvent } from "../native/schema.ts";

type RetryEvent = Extract<
  CodexKnownSessionEvent,
  { readonly method: "routekit-eval/retry" }
>;
type CompactionEvent = Extract<
  CodexKnownSessionEvent,
  { readonly method: "routekit-eval/compaction" }
>;

const projectRetry = function* (
  event: RetryEvent
): Generator<AgentAdapterEvent> {
  const { params } = event;
  const attempt =
    params.attemptNumber === undefined || params.attemptNumber <= 0
      ? {}
      : { attempt: params.attemptNumber };
  if (params.outcome === "scheduled") {
    yield {
      ...attempt,
      ...(params.delayMilliseconds === undefined
        ? {}
        : { delayMs: params.delayMilliseconds }),
      event: "retry.scheduled",
      ...(params.limit === undefined ? {} : { maxAttempts: params.limit }),
      ...(params.reason === undefined ? {} : { message: params.reason }),
    };
    return;
  }
  if (params.outcome === "completed") {
    yield {
      ...attempt,
      event: "retry.completed",
    };
    return;
  }
  if (params.outcome === "cancelled") {
    yield {
      ...attempt,
      event: "retry.cancelled",
    };
    return;
  }
  yield {
    ...attempt,
    event: "retry.failed",
    ...(params.reason === undefined ? {} : { message: params.reason }),
  };
};

// Reuse the schema's Schema.Literals sets (via the decoded compaction variant)
// instead of re-declaring the origin/source unions by hand.
type CompactionRouteKitEvalgin = NonNullable<CompactionEvent["params"]["origin"]>;
type CompactionSource = CompactionEvent["params"]["source"];

const compactionCommon = (
  params: CompactionEvent["params"]
): {
  readonly cause?: CompactionRouteKitEvalgin;
  readonly trigger: CompactionSource;
} => ({
  ...(params.origin === undefined ? {} : { cause: params.origin }),
  trigger: params.source,
});

const projectCompaction = function* (
  event: CompactionEvent
): Generator<AgentAdapterEvent> {
  const { params } = event;
  const common = compactionCommon(params);
  if (params.outcome === "started") {
    yield {
      ...common,
      event: "compaction.started",
    };
    return;
  }
  if (params.outcome === "completed") {
    yield {
      ...common,
      ...(params.afterTokens === undefined
        ? {}
        : { tokensAfter: params.afterTokens }),
      ...(params.beforeTokens === undefined
        ? {}
        : { tokensBefore: params.beforeTokens }),
      ...(params.elapsedMilliseconds === undefined
        ? {}
        : { durationMs: params.elapsedMilliseconds }),
      event: "compaction.completed",
      ...(params.retry === undefined ? {} : { willRetry: params.retry }),
    };
    return;
  }
  if (params.outcome === "cancelled") {
    yield {
      ...common,
      event: "compaction.cancelled",
    };
    return;
  }
  yield {
    ...common,
    event: "compaction.failed",
    ...(params.reason === undefined ? {} : { message: params.reason }),
    ...(params.retry === undefined ? {} : { willRetry: params.retry }),
  };
};

/**
 * Projects a decoded Codex session event to ACP observation events (retry and
 * compaction). Yields nothing when the event is not an observation, so the
 * projector can concatenate this arm with the session-update arm.
 *
 * @yields {AgentAdapterEvent} each ACP observation event (retry, compaction).
 */
const projectCodexObservation = function* (
  event: CodexKnownSessionEvent
): Generator<AgentAdapterEvent> {
  const { guards } = CodexKnownSessionEvent;
  if (guards["routekit-eval/retry"](event)) {
    yield* projectRetry(event);
    return;
  }
  if (guards["routekit-eval/compaction"](event)) {
    yield* projectCompaction(event);
    return;
  }
  // Codex's own compaction notification carries no trigger/cause detail (that
  // level of detail only comes from the `routekit-eval/compaction` companion event), so
  // it degrades to a completed compaction of unknown origin rather than being
  // dropped.
  if (guards["thread/compacted"](event)) {
    yield {
      event: "compaction.completed",
      trigger: "unknown",
    };
  }
};

export { projectCodexObservation };
