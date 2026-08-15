import type { AgentRuntimeEvent } from "../../../../contracts/author/src/index.ts";

import { AgentRuntimeEventTag } from "../../../../contracts/author/src/agent-event.ts";

// Upper bound on how many leading events readResumeAttemptPrefix buffers while
// classifying a resume attempt as retry-vs-replay. Both signals it waits for — a
// missing-session rejection and a flush event (assistant delta, ToolStarted,
// terminal) — arrive within the first few events. If neither shows up within this
// many events (a stalled/non-flushing runtime), stop buffering and treat the
// prefix as a replay so the fallback yields what it has instead of blocking on an
// unbounded buffer forever (Issue 4).
const MAX_RESUME_PREFIX_EVENTS = 100;

type ResumeAttemptPrefix =
  | {
      readonly buffered: readonly AgentRuntimeEvent[];
      readonly kind: "replay";
    }
  | {
      readonly kind: "retry";
    };

const closeAsyncIterator = async <Value>(
  iterator: AsyncIterator<Value>
): Promise<void> => {
  const close = iterator.return;
  if (close === undefined) {
    return;
  }

  await close.call(iterator);
};

const readRemainingEvents = async function* (
  iterator: AsyncIterator<AgentRuntimeEvent>
): AsyncGenerator<AgentRuntimeEvent> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
    yield next.value;
  }
};

const runtimeFailureCode = (event: AgentRuntimeEvent): string | undefined => {
  if (event.type === AgentRuntimeEventTag.RuntimeError) {
    return event.payload.failure.code;
  }

  if (
    event.type === AgentRuntimeEventTag.TurnFailed ||
    event.type === AgentRuntimeEventTag.SessionFailed
  ) {
    return event.payload.failure.code;
  }

  return undefined;
};

const isMissingSessionEvent = (event: AgentRuntimeEvent): boolean =>
  runtimeFailureCode(event) === "ROUTEKIT_EVAL_SESSION_NOT_FOUND";

// Events that prove the resumed session is live (content is flowing) or has
// reached a terminal outcome — either way the buffered prefix can replay.
const RESUME_FLUSH_EVENT_TYPES: ReadonlySet<AgentRuntimeEvent["type"]> =
  new Set([
    AgentRuntimeEventTag.AssistantTextDelta,
    AgentRuntimeEventTag.CompactionStarted,
    AgentRuntimeEventTag.CompactionCompleted,
    AgentRuntimeEventTag.ReasoningDelta,
    AgentRuntimeEventTag.ToolOutputDelta,
    AgentRuntimeEventTag.ContentDelta,
    AgentRuntimeEventTag.ToolStarted,
    AgentRuntimeEventTag.PermissionRequested,
    AgentRuntimeEventTag.ElicitationRequested,
    AgentRuntimeEventTag.TurnSucceeded,
    AgentRuntimeEventTag.TurnFailed,
    AgentRuntimeEventTag.SessionSucceeded,
    AgentRuntimeEventTag.SessionFailed,
  ]);

const shouldFlushBufferedResumeAttempt = (event: AgentRuntimeEvent): boolean =>
  RESUME_FLUSH_EVENT_TYPES.has(event.type);

const readResumeAttemptPrefix = async (
  iterator: AsyncIterator<AgentRuntimeEvent>
): Promise<ResumeAttemptPrefix> => {
  const buffered: AgentRuntimeEvent[] = [];

  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return {
        buffered,
        kind: "replay",
      };
    }

    const { value: event } = next;
    if (isMissingSessionEvent(event)) {
      return { kind: "retry" };
    }

    buffered.push(event);
    if (shouldFlushBufferedResumeAttempt(event)) {
      return {
        buffered,
        kind: "replay",
      };
    }

    // Without this cap a stalled/non-flushing runtime (no flush event, no
    // missing-session failure) buffers unbounded and blocks the fallback before
    // it yields anything. Give up classifying at the cap and replay what we have;
    // the rest streams through readRemainingEvents (Issue 4).
    if (buffered.length >= MAX_RESUME_PREFIX_EVENTS) {
      return {
        buffered,
        kind: "replay",
      };
    }
  }
};

// `retryFresh` is a thunk so this stays harness/transport-agnostic and
// unit-testable against a plain async iterator.
const runWithMissingSessionFallback = async function* (
  events: AsyncGenerator<AgentRuntimeEvent>,
  retryFresh: () => AsyncGenerator<AgentRuntimeEvent>
): AsyncGenerator<AgentRuntimeEvent> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    const prefix = await readResumeAttemptPrefix(iterator);

    if (prefix.kind === "retry") {
      await closeAsyncIterator(iterator);
      yield* retryFresh();
      return;
    }

    yield* prefix.buffered;
    yield* readRemainingEvents(iterator);
  } finally {
    await closeAsyncIterator(iterator);
  }
};

export {
  isMissingSessionEvent,
  MAX_RESUME_PREFIX_EVENTS,
  readResumeAttemptPrefix,
  runWithMissingSessionFallback,
};
export type { ResumeAttemptPrefix };
