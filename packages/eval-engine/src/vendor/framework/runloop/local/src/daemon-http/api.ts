import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import { AgentRuntimeEventSchema } from "../../../../contracts/internal/src/runtime/agent-runtime-event.ts";
import { DevLogRunsResponseSchema } from "../../../../contracts/internal/src/runtime/dev-event-log.ts";
import { FeaturesIntrospectionResponseSchema } from "../../../../contracts/internal/src/runtime/feature-introspection.ts";
import { RuntimeJournalEntrySchema } from "../../../../contracts/internal/src/runtime/journal-entry.ts";
import { SessionMetadataSchema } from "../../../../contracts/internal/src/runtime/session-metadata.ts";
import {
  RuntimeSessionSnapshotSchema,
  RuntimeSessionsResponseSchema,
} from "../../../../contracts/internal/src/runtime/session-snapshot.ts";
import { scheduleGroup } from "../schedule/schedule-http-api.ts";

const NOT_FOUND_STATUS = 404;
const INTERNAL_ERROR_STATUS = 500;

// `:id` path parameter shared by the session detail, events, and lineage
// endpoints. HttpApi percent-decodes captured params, so a handler sees the
// raw session id even when the wire carried `%20`.
const SessionIdParams = Schema.Struct({ id: Schema.String });

// The unary `/api/events` filter. HttpApi decodes query values as strings, and
// the raw route treated any present `sessionId` as a literal id to match, so the
// contract keeps it a free-form optional string rather than a branded id.
const EventsQuery = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
});

// The lone session-not-found body, tag-free to match the fixed wire the raw
// routes emit (`{"error":"Session not found"}`); a `_tag` would change the bytes
// existing HTTP callers parse. The `error` field is a `Literal`, not a free
// `String`: the `events` endpoint declares this 404 alongside the 500
// `SessionEventsUnavailableError`, and HttpApi encodes an error-union value with
// the FIRST member whose schema accepts it. Two `{error: String}` structs are
// indistinguishable, so a 500 disk failure would encode as this 404 (Devin found
// this). Pinning the field to the one constant 404 string this route ever emits
// makes the members disjoint — a dynamic disk-error message fails this literal
// and falls through to the 500 member — with a byte-identical wire body.
const SessionNotFoundError = Schema.Struct({
  error: Schema.Literal("Session not found"),
}).pipe(HttpApiSchema.status(NOT_FOUND_STATUS));

// A disk-read failure while assembling `GET /api/sessions/:id/events`. The raw
// route let this `RuntimeServerError` escape to the daemon's 500 envelope; the
// HttpApi endpoint declares only structs, so the handler maps it to this tag-free
// `{error}` at 500 (the #1261 `dispatchBody` pattern) rather than letting an
// undeclared failure `orDie` into a defect the fall-through can't recover. The
// `error` is a free `String` (the dynamic failure message), disjoint from the
// 404 literal above so the encoder assigns the correct status.
const SessionEventsUnavailableError = Schema.Struct({
  error: Schema.String,
}).pipe(HttpApiSchema.status(INTERNAL_ERROR_STATUS));

// `{sessions}` body of `GET /api/sessions/persisted`: the durable per-session
// sidecars from disk, distinct from the in-memory snapshots at `GET
// /api/sessions`. Formerly declared inline in the daemon log client; it now
// lives with the contract so the derived client reads it from the API.
const PersistedSessionsResponseSchema = Schema.Struct({
  sessions: Schema.Array(SessionMetadataSchema),
});

// `{events}` body of `GET /api/sessions/:id/events`: the session's historical
// runtime events, read from the durable log so the view survives daemon exit.
const SessionEventsResponseSchema = Schema.Struct({
  events: Schema.Array(AgentRuntimeEventSchema),
});

// `{lineage}` body of `GET /api/sessions/:id/lineage`: the session's ancestry,
// newest first, walked through the in-memory registry's `parentSessionId` links.
const SessionLineageResponseSchema = Schema.Struct({
  lineage: Schema.Array(RuntimeSessionSnapshotSchema),
});

// `{events}` body of `GET /api/events`: the daemon's in-memory journal entries
// (optionally filtered to one session). The key is `events` for wire parity even
// though the values are journal *entries* (each wraps one event plus sequence).
const RuntimeEventsResponseSchema = Schema.Struct({
  events: Schema.Array(RuntimeJournalEntrySchema),
});

// `{ok, service}` body of `GET /health`: the daemon liveness probe. Field order
// (`ok` before `service`) matches the raw route's literal for byte parity.
const HealthResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.String,
});

const sessionsGroup = HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/api/sessions", {
      success: RuntimeSessionsResponseSchema,
    })
  )
  .add(
    HttpApiEndpoint.get("persisted", "/api/sessions/persisted", {
      success: PersistedSessionsResponseSchema,
    })
  )
  .add(
    HttpApiEndpoint.get("detail", "/api/sessions/:id", {
      error: [SessionNotFoundError],
      params: SessionIdParams,
      success: SessionMetadataSchema,
    })
  )
  .add(
    HttpApiEndpoint.get("events", "/api/sessions/:id/events", {
      error: [SessionNotFoundError, SessionEventsUnavailableError],
      params: SessionIdParams,
      success: SessionEventsResponseSchema,
    })
  )
  .add(
    HttpApiEndpoint.get("lineage", "/api/sessions/:id/lineage", {
      error: [SessionNotFoundError],
      params: SessionIdParams,
      success: SessionLineageResponseSchema,
    })
  );

const eventsGroup = HttpApiGroup.make("events").add(
  HttpApiEndpoint.get("list", "/api/events", {
    query: EventsQuery,
    success: RuntimeEventsResponseSchema,
  })
);

const logsGroup = HttpApiGroup.make("logs").add(
  HttpApiEndpoint.get("runs", "/api/logs/runs", {
    success: DevLogRunsResponseSchema,
  })
);

const featuresGroup = HttpApiGroup.make("features").add(
  HttpApiEndpoint.get("list", "/api/features", {
    success: FeaturesIntrospectionResponseSchema,
  })
);

const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("check", "/health", {
    success: HealthResponseSchema,
  })
);

/**
 * The single daemon-level HttpApi: one group per unary domain, generalizing the
 * schedules-only spike (#1261) into the whole unary read surface. Streaming
 * endpoints (NDJSON, text tails, invoke, the feature-route passthrough) are NOT
 * modelled here — HttpApi v4 has no stream schema, so they stay raw in the
 * daemon and are matched before this API's mount.
 */
export const DaemonHttpApi = HttpApi.make("daemon")
  .add(scheduleGroup)
  .add(sessionsGroup)
  .add(eventsGroup)
  .add(logsGroup)
  .add(featuresGroup)
  .add(healthGroup);

export {
  SessionIdParams,
  SessionNotFoundError,
  SessionEventsUnavailableError,
  PersistedSessionsResponseSchema,
  SessionEventsResponseSchema,
  SessionLineageResponseSchema,
  RuntimeEventsResponseSchema,
  HealthResponseSchema,
};

/** The session-not-found body value handlers `Effect.fail`, matching the wire. */
export type SessionNotFoundErrorBody = typeof SessionNotFoundError.Type;
/** The `/api/sessions/:id/events` disk-read 500 body, tag-free like the wire. */
export type SessionEventsUnavailableErrorBody =
  typeof SessionEventsUnavailableError.Type;
