import { Schema } from "effect";

import type { ClaudeInbound } from "../native/schema.ts";
import type { AgentAdapterEvent } from "../../../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { ApiRetryEvent, CompactBoundaryEvent } from "../native/schema.ts";

const isApiRetry = Schema.is(ApiRetryEvent);
const isCompactBoundary = Schema.is(CompactBoundaryEvent);

/**
 * Projects a decoded Claude `system` event to ACP observation events (retry and
 * compaction). Yields nothing for events this arm does not own, so the projector
 * can concatenate arms without a sentinel return. No provider payload is copied
 * into the canonical journal.
 *
 * @yields {AgentAdapterEvent} each ACP observation event from `event`.
 */
const projectClaudeObservation = function* (
  event: ClaudeInbound
): Generator<AgentAdapterEvent> {
  if (isApiRetry(event)) {
    yield {
      attempt: event.attempt,
      delayMs: Math.round(event.retry_delay_ms),
      event: "retry.scheduled",
      maxAttempts: event.max_retries,
      ...(event.error === undefined ? {} : { message: event.error }),
    };
    return;
  }
  if (isCompactBoundary(event)) {
    const trigger =
      event.compact_metadata?.trigger === "manual" ? "manual" : "automatic";
    yield {
      event: "compaction.completed",
      trigger,
      ...(event.compact_metadata?.pre_tokens === undefined
        ? {}
        : { tokensBefore: event.compact_metadata.pre_tokens }),
    };
  }
};

export { projectClaudeObservation };
