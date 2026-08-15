// pi owns the OpenRouter request, so ori cannot lower max_tokens in place. When
// OpenRouter rejects a turn with a 402 ("requires more credits, or fewer
// max_tokens ... can only afford N"), the harness re-invokes pi with a lower
// models.json cap. It streams one attempt, holding back its pre-content
// events so a 402 that fails BEFORE any output can be retried cleanly.

import type { AgentRuntimeEvent } from "../../../ori/src/index.ts";

import { Stream } from "effect";
import { isTerminalRuntimeEvent } from "../../../ori/src/index.ts";
import { AgentRuntimeEventTag } from "../../../ori/src/enums.ts";

import { clampMaxTokensToAfford } from "../model/model.ts";

const EMPTY_COUNT = 0;

// Events that mean the turn produced real, user-visible progress. Once one is
// seen the attempt is COMMITTED: we stop buffering and never retry, so a clamp
// can only kick in on a 402 that fails before any output.
const COMMIT_EVENT_TYPES = new Set<AgentRuntimeEvent["type"]>([
  AgentRuntimeEventTag.AssistantTextDelta,
  AgentRuntimeEventTag.ReasoningDelta,
  AgentRuntimeEventTag.ToolStarted,
]);

// The affordable-tokens figure from a clampable OpenRouter 402 carried by an
// event (pi surfaces the provider error as a RuntimeError; the synthesized
// terminal SessionFailed may carry it too), or undefined for any other event.
const clampableAffordFromEvent = (
  event: AgentRuntimeEvent
): number | undefined => {
  if (event.type === AgentRuntimeEventTag.RuntimeError) {
    return event.payload.failure.retryWithMaxOutputTokens;
  }
  if (event.type === AgentRuntimeEventTag.SessionFailed) {
    return event.payload.failure.retryWithMaxOutputTokens;
  }
  return undefined;
};

export interface ClampableAttemptResult {
  readonly clampTo?: number | undefined;
}

// Stream one pi attempt, buffering the pre-content events so a fast 402 (which
// fails before any output) can be retried cleanly. On the first COMMIT event the
// buffer is flushed and the rest streams live — from then on the attempt is
// committed and never retried. Returns `{ clampTo }` when the attempt failed with
// a clampable 402 before committing AND `canRetry` is set, so the caller
// re-invokes pi with a lower max_tokens; otherwise yields the attempt's events
// (including the terminal failure) and returns `{}`.
export const runClampableAttempt = async function* (
  events: Stream.Stream<AgentRuntimeEvent, Error>,
  canRetry: boolean
): AsyncGenerator<AgentRuntimeEvent, ClampableAttemptResult, unknown> {
  const buffered: AgentRuntimeEvent[] = [];
  let committed = false;
  let afford: number | undefined;

  for await (const event of Stream.toAsyncIterable(events)) {
    if (committed) {
      yield event;
      continue;
    }
    if (COMMIT_EVENT_TYPES.has(event.type)) {
      committed = true;
      yield* buffered;
      buffered.length = EMPTY_COUNT;
      yield event;
      continue;
    }
    afford ??= clampableAffordFromEvent(event);
    buffered.push(event);
    if (isTerminalRuntimeEvent(event)) {
      if (canRetry && afford !== undefined) {
        return { clampTo: clampMaxTokensToAfford(afford) };
      }
      yield* buffered;
      return {};
    }
  }
  if (!committed) {
    yield* buffered;
  }
  return {};
};
