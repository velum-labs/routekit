import { Effect, Filter, Option, Stream } from "effect";

import type { DevEventLogEntry } from "../../../../contracts/internal/src/runtime/dev-event-log.ts";
import type { RuntimeSessionSnapshot } from "../../../../contracts/internal/src/runtime/session-snapshot-types.ts";
import type {
  SessionEventsUnavailableErrorBody,
  SessionNotFoundErrorBody,
} from "./api.ts";

import { SessionId } from "../../../../contracts/internal/src/ids.ts";
import { journalEntrySessionId } from "../../../../contracts/internal/src/runtime/journal-entry-session.ts";
import { RuntimeEventJournal } from "../../../../engine/events/src/event-journal-service.ts";
import { AgentSessionStore } from "../../../../engine/session/src/session-store-service.ts";
import { DevLogStore } from "../dev/log-store.ts";

// The single session-not-found wire body, shared by the three `:id` endpoints.
// Tag-free to match the fixed wire the raw routes emitted (`{"error":"Session
// not found"}`); the declaring endpoint encodes it at 404.
const sessionNotFoundError: SessionNotFoundErrorBody = {
  error: "Session not found",
};

/**
 * `GET /api/sessions` body: the daemon's in-memory session snapshots, lost on
 * restart. Reads the ambient {@link AgentSessionStore}; never fails.
 */
const listSessionsBody = Effect.gen(function* () {
  const store = yield* AgentSessionStore;
  const sessions = yield* store.list();
  return { sessions };
});

/**
 * `GET /api/sessions/persisted` body: the durable per-session sidecars from
 * disk. `listPersistedSessions` is optional on the store (an inert log store
 * omits it), so an absent method yields an empty list, matching the raw route.
 */
const listPersistedSessionsBody = Effect.gen(function* () {
  const store = yield* DevLogStore;
  const sessions =
    store.listPersistedSessions === undefined
      ? []
      : yield* store.listPersistedSessions();
  return { sessions };
});

/**
 * `GET /api/sessions/:id` body: one session's persisted sidecar metadata, read
 * from disk so it survives daemon exit. Fails the tag-free not-found struct
 * (encoded at 404) for an unknown id.
 */
const sessionDetailBody = Effect.fn("RuntimeHttp.sessionDetailBody")(function* (
  sessionId: string
) {
  const store = yield* DevLogStore;
  const metadata = yield* store.readSession(sessionId);
  if (Option.isNone(metadata)) {
    return yield* Effect.fail(sessionNotFoundError);
  }
  return metadata.value;
});

/**
 * `GET /api/sessions/:id/events` body: the session's historical runtime events,
 * read across every persisted run's sidecar (disk-backed, so a live reader and a
 * file reader see the same view). Fails the not-found struct for an unknown id.
 */
const sessionEventsBody = Effect.fn("RuntimeHttp.sessionEventsBody")(function* (
  sessionId: string
) {
  const store = yield* DevLogStore;
  const metadata = yield* store.readSession(sessionId);
  if (Option.isNone(metadata)) {
    return yield* Effect.fail(sessionNotFoundError);
  }
  const runs = (yield* store.list()).toSorted((left, right) =>
    (left.startedAt ?? left.id).localeCompare(right.startedAt ?? right.id)
  );
  // Concat each run's runtime-event records (in run order) into one stream and
  // project the wrapped event out of each. `store.read` fails `RuntimeServerError`
  // on a disk read; the endpoint declares only structs, so map it to the tag-free
  // 500 body (the #1261 `dispatchBody` pattern) rather than an undeclared defect.
  const events = yield* Stream.fromIterable(runs).pipe(
    Stream.flatMap((run) =>
      store.read(run.id, {
        sessionId,
        type: "runtime.event",
      })
    ),
    Stream.filterMap(
      Filter.fromPredicateOption((entry: DevEventLogEntry) =>
        entry.type === "runtime.event"
          ? Option.some(entry.entry.event)
          : Option.none()
      )
    ),
    Stream.runCollect,
    Effect.mapError(
      (cause): SessionEventsUnavailableErrorBody => ({ error: cause.message })
    )
  );
  return { events };
});

// Walk `parentSessionId` links through the in-memory registry, newest first.
// The seen-set bounds a malformed parent cycle; a parent missing from the
// registry ends the walk with the chain collected so far rather than failing.
const collectSessionLineage = Effect.fn("RuntimeHttp.sessionLineage")(
  function* (sessionId: string) {
    const store = yield* AgentSessionStore;
    const lineage: RuntimeSessionSnapshot[] = [];
    const seen = new Set<string>();
    let current: string | undefined = sessionId;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const snapshot: RuntimeSessionSnapshot | undefined =
        Option.getOrUndefined(yield* store.get(SessionId.make(current)));
      if (snapshot === undefined) {
        break;
      }
      lineage.push(snapshot);
      current = snapshot.parentSessionId;
    }
    return lineage;
  }
);

/**
 * `GET /api/sessions/:id/lineage` body: the session's ancestry, newest first,
 * following `parentSessionId` links (rollover ORI-471 and Fork Thread RFC 0003
 * both stamp them). An empty chain means the id is unknown to the in-memory
 * registry, which fails the not-found struct exactly as the raw route did.
 */
const sessionLineageBody = Effect.fn("RuntimeHttp.sessionLineageBody")(
  function* (sessionId: string) {
    const lineage = yield* collectSessionLineage(sessionId);
    if (lineage.length === 0) {
      return yield* Effect.fail(sessionNotFoundError);
    }
    return { lineage };
  }
);

/**
 * `GET /api/events` body: the daemon's in-memory journal entries, optionally
 * filtered to one session (Fork Thread, RFC 0003 / RFC 0008). An unknown id
 * yields an empty result rather than a 404; never fails.
 */
const listRuntimeEventsBody = Effect.fn("RuntimeHttp.listRuntimeEventsBody")(
  function* (sessionFilter: string | undefined) {
    const journal = yield* RuntimeEventJournal;
    const events = yield* journal.entries();
    return {
      events:
        sessionFilter === undefined
          ? events
          : events.filter(
              (entry) => journalEntrySessionId(entry) === sessionFilter
            ),
    };
  }
);

/**
 * `GET /api/logs/runs` body: the persisted dev event-log runs the daemon serves
 * from disk (RFC 0004). Never fails; an unconfigured store lists nothing.
 */
const listLogRunsBody = Effect.gen(function* () {
  const store = yield* DevLogStore;
  const runs = yield* store.list();
  return { runs };
});

export {
  listSessionsBody,
  listPersistedSessionsBody,
  sessionDetailBody,
  sessionEventsBody,
  sessionLineageBody,
  listRuntimeEventsBody,
  listLogRunsBody,
};
