import type { RunId, SessionId } from "../../../contracts/internal/src/ids.ts";
import type { AgentRuntimeEvent } from "../../../contracts/internal/src/runtime/agent-runtime-event-types.ts";
import type {
  SessionMetadata,
  SessionRunMetadata,
} from "../../../contracts/internal/src/runtime/session-metadata.ts";

import { SessionId as SessionIdSchema } from "../../../contracts/internal/src/ids.ts";
import { AgentRuntimeEventTag } from "../../../contracts/internal/src/runtime/agent-runtime-event.ts";

const TURN_INCREMENT = 1;

/**
 * The projection accumulator. `run.started` carries a run's `cwd`/`model`/
 * `prompt` but fires **before** the session id is known (the runtime parses the
 * session id out of the harness's later output), so a fold keyed only on
 * `sessionId` would drop that context. We therefore track run context by
 * `runId` independently and attach it to the session the moment a session-keyed
 * event first references that run — which is exactly why the invariants forbid
 * treating run and session as a single-parent hierarchy.
 */
export interface SessionMetadataProjection {
  readonly runContexts: ReadonlyMap<RunId, SessionRunMetadata>;
  readonly sessions: ReadonlyMap<SessionId, SessionMetadata>;
}

export const emptySessionMetadataProjection: SessionMetadataProjection = {
  runContexts: new Map(),
  sessions: new Map(),
};

/**
 * Resolve the session a runtime event belongs to. Mirrors the in-memory
 * session-store's rule exactly: the hoisted `event.sessionId` wins, and a
 * `session.started` event's `payload.sessionId` seeds the id the instant the
 * harness first emits it. Returns `undefined` for events that carry no session
 * (they belong to the run, not any session, per the RFC's run/session
 * invariants) so the caller leaves them out of every session-keyed projection.
 */
const runtimeSessionId = (event: AgentRuntimeEvent): SessionId | undefined => {
  if (event.sessionId) {
    return event.sessionId;
  }
  if (event.type === AgentRuntimeEventTag.SessionStarted) {
    return event.payload.sessionId === undefined
      ? undefined
      : SessionIdSchema.make(event.payload.sessionId);
  }
  return undefined;
};

const terminalUsage = (
  event: AgentRuntimeEvent
): SessionMetadata["usage"] | undefined => {
  if (
    event.type === AgentRuntimeEventTag.SessionSucceeded ||
    event.type === AgentRuntimeEventTag.SessionFailed
  ) {
    return event.payload.usage;
  }
  if (
    event.type === AgentRuntimeEventTag.TurnSucceeded ||
    event.type === AgentRuntimeEventTag.TurnFailed
  ) {
    return event.payload.usage;
  }
  return undefined;
};

const accumulateTurnUsage = (
  previous: SessionMetadata["usage"],
  current: NonNullable<SessionMetadata["usage"]>
): NonNullable<SessionMetadata["usage"]> => {
  // Turn terminals report one round at a time. Token and cost counters are
  // session totals; contextTokens is occupancy, so it follows the latest turn.
  const contextTokens = current.contextTokens ?? previous?.contextTokens;
  const costUsd =
    current.costUsd === undefined
      ? previous?.costUsd
      : (previous?.costUsd ?? 0) + current.costUsd;
  const model = current.model ?? previous?.model;
  return {
    cacheCreationTokens:
      (previous?.cacheCreationTokens ?? 0) + current.cacheCreationTokens,
    cacheReadTokens: (previous?.cacheReadTokens ?? 0) + current.cacheReadTokens,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
    ...(model === undefined ? {} : { model }),
    outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
  };
};

// Keyed by runId independently of session so a run's context survives arriving
// before the session id is known.
const recordRunContext = (
  runContexts: ReadonlyMap<RunId, SessionRunMetadata>,
  event: AgentRuntimeEvent
): ReadonlyMap<RunId, SessionRunMetadata> => {
  if (event.type !== AgentRuntimeEventTag.RunStarted) {
    return runContexts;
  }
  const context: SessionRunMetadata = {
    runId: event.runId,
    cwd: event.payload.cwd,
    model: event.payload.model,
    prompt: event.payload.prompt,
    userId: event.payload.userId,
  };
  return new Map([...runContexts, [event.runId, context]]);
};

const upsertSessionRun = (
  runIds: readonly SessionRunMetadata[],
  runContexts: ReadonlyMap<RunId, SessionRunMetadata>,
  runId: RunId
): readonly SessionRunMetadata[] => {
  const context = runContexts.get(runId) ?? { runId };
  const existingIndex = runIds.findIndex((entry) => entry.runId === runId);
  if (existingIndex === -1) {
    return [...runIds, context];
  }
  const next = [...runIds];
  next[existingIndex] = {
    ...next[existingIndex],
    ...context,
  };
  return next;
};

/**
 * Fold one runtime event into the session-metadata projection. This is the
 * durable twin of the in-memory session store's `applySessionEvent`: it derives
 * the same shape (harness, turn counts, `lastEventType`, timestamps) and adds
 * the run-level context the events already carry (`startedAt`/`endedAt`,
 * terminal `usage`, and the per-run `runIds` array). `run.started` context is
 * recorded by runId regardless of session; events with no session id update no
 * session (they belong to the run, not a session).
 */
export const applySessionMetadataEvent = (
  projection: SessionMetadataProjection,
  event: AgentRuntimeEvent
): SessionMetadataProjection => {
  const runContexts = recordRunContext(projection.runContexts, event);
  const sessionId = runtimeSessionId(event);
  if (!sessionId) {
    return {
      runContexts,
      sessions: projection.sessions,
    };
  }

  const sessions = new Map(projection.sessions);
  const previous = sessions.get(sessionId);
  const base: SessionMetadata = previous ?? {
    completedTurns: 0,
    endedAt: event.createdAt,
    failedTurns: 0,
    harness: event.harness,
    lastEventType: event.type,
    runIds: [],
    sessionId,
    startedAt: event.createdAt,
  };

  const usage = terminalUsage(event);
  let nextUsage = base.usage;
  if (usage !== undefined) {
    const isTurnTerminal =
      event.type === AgentRuntimeEventTag.TurnSucceeded ||
      event.type === AgentRuntimeEventTag.TurnFailed;
    nextUsage = isTurnTerminal ? accumulateTurnUsage(base.usage, usage) : usage;
  }
  sessions.set(sessionId, {
    ...base,
    completedTurns:
      event.type === AgentRuntimeEventTag.TurnSucceeded
        ? base.completedTurns + TURN_INCREMENT
        : base.completedTurns,
    endedAt: event.createdAt,
    failedTurns:
      event.type === AgentRuntimeEventTag.TurnFailed
        ? base.failedTurns + TURN_INCREMENT
        : base.failedTurns,
    harness: event.harness,
    lastEventType: event.type,
    runIds: upsertSessionRun(base.runIds, runContexts, event.runId),
    ...(nextUsage === undefined ? {} : { usage: nextUsage }),
  });

  return {
    runContexts,
    sessions,
  };
};

/**
 * Project a full run stream into a `sessionId → metadata` map. A pure fold, so
 * the sidecar is always a rebuildable projection over the authoritative run
 * file (never a second writer) — the same guarantee the in-memory store gives.
 */
export const projectSessionMetadata = (
  events: Iterable<AgentRuntimeEvent>
): ReadonlyMap<SessionId, SessionMetadata> => {
  let projection = emptySessionMetadataProjection;
  for (const event of events) {
    projection = applySessionMetadataEvent(projection, event);
  }
  return projection.sessions;
};
