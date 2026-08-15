import { Effect, Layer, Option, Ref } from "effect";

import type { AgentSessionStoreShape } from "./session-store-service.ts";

import { agentRuntimeEventSessionId } from "../../../contracts/internal/src/runtime/journal-entry-session.ts";
import { AgentSessionStore as AgentSessionStoreService } from "./session-store-service.ts";

const AgentSessionStore = AgentSessionStoreService;

type RuntimeJournalEntry = Parameters<AgentSessionStoreShape["apply"]>[0];
type RuntimeSessionSnapshot =
  ReturnType<AgentSessionStoreShape["list"]> extends Effect.Effect<
    readonly (infer Snapshot)[],
    unknown,
    unknown
  >
    ? Snapshot
    : never;
type AgentRuntimeEvent = RuntimeJournalEntry["event"];
type RunId = RuntimeSessionSnapshot["runIds"][number];
type SessionId = RuntimeSessionSnapshot["sessionId"];
type TurnId = RuntimeSessionSnapshot["turnIds"][number];

const appendUnique = (
  values: readonly RunId[],
  value: RunId
): readonly RunId[] => (values.includes(value) ? values : [...values, value]);

const appendUniqueTurnId = (
  values: readonly TurnId[],
  value: TurnId
): readonly TurnId[] => (values.includes(value) ? values : [...values, value]);

// The occupancy inputs the rollover planner reads: the terminal event's
// RuntimeUsage.contextTokens and the model that produced it.
const terminalUsage = (
  event: AgentRuntimeEvent
):
  | {
      readonly contextTokens?: number | undefined;
      readonly model?: string | undefined;
    }
  | undefined =>
  event.type === "session.succeeded" ||
  event.type === "session.failed" ||
  event.type === "turn.succeeded" ||
  event.type === "turn.failed"
    ? event.payload.usage
    : undefined;

// Rollover pressure transitions: a context-overflow terminal failure or a
// failed harness compaction arms it; a successful turn or a completed
// compaction proves the context is usable again and clears it.
const nextPendingRollover = (
  previous: RuntimeSessionSnapshot["pendingRollover"],
  event: AgentRuntimeEvent
): RuntimeSessionSnapshot["pendingRollover"] => {
  if (event.type === "compaction.failed") {
    return "compaction-failed";
  }
  if (
    (event.type === "session.failed" || event.type === "turn.failed") &&
    event.payload.failure.code === "ROUTEKIT_EVAL_CONTEXT_OVERFLOW"
  ) {
    return "overflow";
  }
  if (
    event.type === "turn.succeeded" ||
    event.type === "session.succeeded" ||
    event.type === "compaction.completed"
  ) {
    return undefined;
  }
  return previous;
};

const applySessionEvent = (
  current: Map<SessionId, RuntimeSessionSnapshot>,
  event: AgentRuntimeEvent
): Map<SessionId, RuntimeSessionSnapshot> => {
  const sessionId = agentRuntimeEventSessionId(event);
  if (!sessionId) {
    return current;
  }

  const next = new Map(current);
  const previous = next.get(sessionId);
  const updatedAt = event.createdAt;
  const base = previous ?? {
    completedTurns: 0,
    failedTurns: 0,
    firstSeenAt: event.createdAt,
    harness: event.harness,
    lastEventType: event.type,
    runIds: [],
    sessionId,
    turnIds: [],
    updatedAt,
  };

  // Lineage is fixed at fork and immutable (Fork Thread, RFC 0003): take it
  // from the first event that carries it and never overwrite it thereafter.
  const parentSessionId = base.parentSessionId ?? event.parentSessionId;
  const usage = terminalUsage(event);
  const lastContextTokens = usage?.contextTokens ?? base.lastContextTokens;
  const lastUsageModel = usage?.model ?? base.lastUsageModel;
  const pendingRollover = nextPendingRollover(base.pendingRollover, event);
  // Rebuild without the previous pendingRollover key: a cleared flag must not
  // survive via the spread (and the wire schema rejects an explicit undefined).
  const { pendingRollover: _previousPendingRollover, ...baseRest } = base;

  next.set(sessionId, {
    ...baseRest,
    completedTurns:
      event.type === "turn.succeeded"
        ? base.completedTurns + 1
        : base.completedTurns,
    failedTurns:
      event.type === "turn.failed" ? base.failedTurns + 1 : base.failedTurns,
    harness: event.harness,
    ...(lastContextTokens === undefined ? {} : { lastContextTokens }),
    lastEventType: event.type,
    ...(lastUsageModel === undefined ? {} : { lastUsageModel }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(pendingRollover === undefined ? {} : { pendingRollover }),
    runIds: appendUnique(base.runIds, event.runId),
    turnIds: event.turnId
      ? appendUniqueTurnId(base.turnIds, event.turnId)
      : base.turnIds,
    updatedAt,
  });

  return next;
};

const projectSessionsFromEntries = (
  entries: readonly RuntimeJournalEntry[]
): Map<SessionId, RuntimeSessionSnapshot> => {
  let current = new Map<SessionId, RuntimeSessionSnapshot>();
  for (const entry of entries) {
    current = applySessionEvent(current, entry.event);
  }
  return current;
};

export const agentSessionStoreLayer = Layer.effect(AgentSessionStore)(
  Effect.gen(function* () {
    const sessions = yield* Ref.make(
      new Map<SessionId, RuntimeSessionSnapshot>()
    );

    const apply = Effect.fn("AgentSessionStore.apply")(
      (entry: RuntimeJournalEntry) =>
        Ref.update(sessions, (current) =>
          applySessionEvent(current, entry.event)
        )
    );
    const get = Effect.fn("AgentSessionStore.get")((sessionId: SessionId) =>
      Ref.get(sessions).pipe(
        Effect.map((current) => {
          const session = current.get(sessionId);
          return session ? Option.some(session) : Option.none();
        })
      )
    );
    const list = Effect.fn("AgentSessionStore.list")(() =>
      Ref.get(sessions).pipe(
        Effect.map((current) =>
          [...current.values()].toSorted((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt)
          )
        )
      )
    );
    const rebuild = Effect.fn("AgentSessionStore.rebuild")(
      (entries: readonly RuntimeJournalEntry[]) =>
        Ref.set(sessions, projectSessionsFromEntries(entries))
    );

    return AgentSessionStore.of({
      apply,
      get,
      list,
      rebuild,
    });
  })
);

export { AgentSessionStore };
