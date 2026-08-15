import type { HttpClient } from "effect/unstable/http";

import { Effect, Schema, Stream } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import type { AgentRuntimeEvent } from "../../../../../contracts/author/src/index.ts";
import type {
  DevEventLogRecordType,
  DevLogRun,
} from "../../../../../contracts/internal/src/runtime/dev-event-log.ts";
import type { SessionMetadata } from "../../../../../contracts/internal/src/runtime/session-metadata.ts";
import type { RuntimeSessionSnapshot } from "../../../../../contracts/internal/src/runtime/session-snapshot-types.ts";
import type { SessionEventsUnavailableErrorBody } from "../../daemon-http/api.ts";
import type { RuntimeClientOptions } from "../client/client-http.ts";

import {
  RuntimeClientError,
  RuntimeProtocolError,
} from "../../../../../contracts/internal/src/errors.ts";
import {
  fetchHttpClientLayer,
  isOkStatus,
} from "../../../../../contracts/internal/src/http-client.ts";
import { DaemonHttpApi } from "../../daemon-http/api.ts";
import {
  decodeRuntimeNdjsonLines,
  fetchRuntimeResponse,
  makeRuntimeClientErrorFromCause,
  makeRuntimeUrl,
  readResponseText,
} from "../client/client-http.ts";

const EMPTY_COUNT = 0;
const NOT_FOUND_STATUS = 404;
const LOGS_RUNS_PATH = "/api/logs/runs";
const SESSIONS_PATH = "/api/sessions";
const FOLLOW_QUERY_VALUE = "true";
const PERSISTED_SESSIONS_PATH = "/api/sessions/persisted";
const SESSION_EVENTS_TIMEOUT = "5 seconds";

interface ReadRuntimeLogRunQuery {
  readonly follow?: boolean;
  readonly sessionId?: string | undefined;
  readonly type?: DevEventLogRecordType | undefined;
}

/**
 * The failure channel of a derived daemon-client call whose endpoint declares no
 * domain errors (the session/log-run LIST reads). `HttpClientError` is a
 * transport failure or an undeclared status; `SchemaError` is a malformed
 * response body.
 */
type UnaryClientError = HttpClientError.HttpClientError | Schema.SchemaError;

/**
 * Map a derived-client failure into the daemon client's error channel,
 * reconstructing the stale-runtime detail the CLI asserts. A 404 means the
 * daemon is reachable but predates this endpoint (an old `ori dev`), so it maps
 * to the "does not expose the {describe} endpoint" message the command surfaces;
 * any other status is a plain "failed with HTTP {status}". A malformed body
 * ({@link Schema.SchemaError}) is a {@link RuntimeProtocolError}, matching the
 * streaming path. The daemon's response body is not carried onto the detail —
 * `HttpClientError` exposes only the status synchronously — so the former
 * `Response: {body}` tail is dropped (it was never asserted).
 */
const toUnaryClientError =
  (options: RuntimeClientOptions, path: string, describe: string) =>
  (error: UnaryClientError): RuntimeClientError | RuntimeProtocolError => {
    const url = makeRuntimeUrl(options, path);
    if (HttpClientError.isHttpClientError(error)) {
      const status = error.response?.status;
      if (status === NOT_FOUND_STATUS) {
        return new RuntimeClientError({
          cause: error,
          detail: `Runtime ${describe} are unavailable at ${url}. The runtime is reachable, but it does not expose the ${describe} endpoint; restart \`ori dev\` from the current checkout and retry.`,
        });
      }
      const suffix = status === undefined ? "" : ` failed with HTTP ${status}`;
      return new RuntimeClientError({
        cause: error,
        detail: `Runtime request to ${url}${suffix}: ${error.message}`,
      });
    }
    return new RuntimeProtocolError({
      cause: error,
      detail: `Invalid ${describe} response`,
    });
  };

/** Derive the typed daemon client once per call, bound to the endpoint origin. */
const makeDaemonClient = (
  options: RuntimeClientOptions
): Effect.Effect<
  HttpApiClient.ForApi<typeof DaemonHttpApi>,
  never,
  HttpClient.HttpClient
> =>
  HttpApiClient.make(DaemonHttpApi, {
    baseUrl: makeRuntimeUrl(options, ""),
  });

/**
 * Lists the agent sessions a running daemon tracks (`GET /api/sessions`). These
 * are in-memory snapshots (lost on restart); the durable per-session history is
 * the `.ori/logs` runs filtered by `sessionId`. Helps agents discover the
 * `sessionId`s to pass to `ori logs --session` or `ori tui --session`.
 */
const listRuntimeSessions = (
  options: RuntimeClientOptions
): Effect.Effect<
  readonly RuntimeSessionSnapshot[],
  RuntimeClientError | RuntimeProtocolError,
  HttpClient.HttpClient
> =>
  makeDaemonClient(options).pipe(
    Effect.flatMap((client) => client.sessions.list()),
    Effect.map((body) => body.sessions),
    Effect.mapError(toUnaryClientError(options, SESSIONS_PATH, "sessions"))
  );

/**
 * Lists the durable per-session sidecar metadata the daemon serves at
 * `GET /api/sessions/persisted`. Runs on a bare runtime via `Effect.runPromise`
 * (the `Chat` contract is Promise-based), so this boundary is the composition
 * root that provides `fetchHttpClientLayer` — the Effect-returning readers above
 * inherit `HttpClient` from the CLI root instead.
 */
export const listPersistedRuntimeSessions = (
  options: RuntimeClientOptions
): Promise<readonly SessionMetadata[]> =>
  Effect.runPromise(
    makeDaemonClient(options).pipe(
      Effect.flatMap((client) => client.sessions.persisted()),
      Effect.map((body) => body.sessions),
      Effect.mapError(
        toUnaryClientError(
          options,
          PERSISTED_SESSIONS_PATH,
          "persisted sessions"
        )
      ),
      Effect.provide(fetchHttpClientLayer)
    )
  );

/**
 * The failure channel of the derived session-events call. The endpoint declares
 * two tag-free `{error}` structs (404 not-found, 500 unavailable); they are
 * structurally identical, so the union reduces to
 * {@link SessionEventsUnavailableErrorBody} at the type level. `SchemaError` is a
 * malformed body; `HttpClientError` is a transport or undeclared-status failure.
 */
type SessionEventsClientError =
  | HttpClientError.HttpClientError
  | SessionEventsUnavailableErrorBody
  | Schema.SchemaError;

/**
 * Map the session-events derived-client failure. A declared domain error arrives
 * as the `{error}` struct (recovered by the remaining case, not a status),
 * keeping the "failed with HTTP {status}" detail shape the raw route surfaced; an
 * undeclared status arrives as an `HttpClientError` whose status is read
 * directly. A malformed body is a protocol error.
 */
const toSessionEventsError =
  (options: RuntimeClientOptions, sessionId: string) =>
  (
    error: SessionEventsClientError
  ): RuntimeClientError | RuntimeProtocolError => {
    const path = `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/events`;
    const url = makeRuntimeUrl(options, path);
    if (HttpClientError.isHttpClientError(error)) {
      const status = error.response?.status;
      const suffix = status === undefined ? "" : ` failed with HTTP ${status}`;
      return new RuntimeClientError({
        cause: error,
        detail: `Runtime session events request to ${url}${suffix}: ${error.message}`,
      });
    }
    if (Schema.isSchemaError(error)) {
      return new RuntimeProtocolError({
        cause: error,
        detail: "Invalid session events response",
      });
    }
    return new RuntimeClientError({
      cause: error,
      detail: `Runtime session events request to ${url} failed: ${error.error}`,
    });
  };

export const loadRuntimeSessionEvents = (
  options: RuntimeClientOptions,
  sessionId: string
): Promise<readonly AgentRuntimeEvent[]> =>
  Effect.runPromise(
    makeDaemonClient(options).pipe(
      Effect.flatMap((client) =>
        client.sessions.events({ params: { id: sessionId } })
      ),
      Effect.map((body) => body.events),
      Effect.mapError(toSessionEventsError(options, sessionId)),
      Effect.timeoutOrElse({
        duration: SESSION_EVENTS_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RuntimeClientError({
              detail:
                "Runtime session events request timed out after 5 seconds.",
            })
          ),
      }),
      Effect.provide(fetchHttpClientLayer)
    )
  );

/**
 * Lists the persisted dev event-log runs the daemon serves at
 * `GET /api/logs/runs`. The remote counterpart of reading `.ori/logs/` from
 * disk; used by `ori logs` when targeting a `--host`/`--port` daemon.
 */
const listRuntimeLogRuns = (
  options: RuntimeClientOptions
): Effect.Effect<
  readonly DevLogRun[],
  RuntimeClientError | RuntimeProtocolError,
  HttpClient.HttpClient
> =>
  makeDaemonClient(options).pipe(
    Effect.flatMap((client) => client.logs.runs()),
    Effect.map((body) => body.runs),
    Effect.mapError(toUnaryClientError(options, LOGS_RUNS_PATH, "log runs"))
  );

const makeLogRunPath = (
  runId: string,
  query: ReadRuntimeLogRunQuery
): string => {
  const search = new URLSearchParams();
  if (query.sessionId !== undefined) {
    search.set("sessionId", query.sessionId);
  }
  if (query.type !== undefined) {
    search.set("type", query.type);
  }
  if (query.follow === true) {
    search.set("follow", FOLLOW_QUERY_VALUE);
  }
  const suffix = search.toString();
  return `${LOGS_RUNS_PATH}/${encodeURIComponent(runId)}${suffix.length === EMPTY_COUNT ? "" : `?${suffix}`}`;
};

interface RuntimeLineStreamTarget {
  readonly describe: string;
  readonly path: string;
}

const fetchRuntimeStreamBody = Effect.fn(
  "DaemonLogClient.fetchRuntimeStreamBody"
)(function* (options: RuntimeClientOptions, target: RuntimeLineStreamTarget) {
  const response = yield* fetchRuntimeResponse(options, target.path);

  if (isOkStatus(response.status)) {
    return response.stream.pipe(
      Stream.mapError(
        makeRuntimeClientErrorFromCause(
          `Failed to read local Ori runtime ${target.describe} at ${makeRuntimeUrl(options, target.path)}`
        )
      )
    );
  }

  const body = yield* readResponseText(options, target.path, response);
  return yield* new RuntimeClientError({
    detail:
      response.status === NOT_FOUND_STATUS
        ? `Runtime ${target.describe} is unavailable at ${makeRuntimeUrl(options, target.path)}. The runtime is reachable, but it does not expose the ${target.describe} endpoint; restart \`ori dev\` from the current checkout and retry. Response: ${body}`
        : `Runtime ${target.describe} failed with HTTP ${response.status}: ${body}`,
  });
});

const tailRuntimeLineStream = (
  options: RuntimeClientOptions,
  target: RuntimeLineStreamTarget
): Stream.Stream<string, RuntimeClientError, HttpClient.HttpClient> =>
  Stream.unwrap(
    fetchRuntimeStreamBody(options, target).pipe(
      Effect.map(decodeRuntimeNdjsonLines)
    )
  );

/**
 * Tails one persisted run (`GET /api/logs/runs/:id`) as raw NDJSON lines, with
 * the same `sessionId`/`type`/`follow` filters the CLI exposes. `latest`
 * resolves the newest run server-side. Stays a raw byte-stream read (not the
 * derived client) because HttpApi v4 has no NDJSON stream schema.
 */
export const readRuntimeLogRun = (
  options: RuntimeClientOptions,
  runId: string,
  query: ReadRuntimeLogRunQuery = {}
): Stream.Stream<string, RuntimeClientError, HttpClient.HttpClient> =>
  tailRuntimeLineStream(options, {
    describe: "log run stream",
    path: makeLogRunPath(runId, query),
  });

export { listRuntimeSessions, listRuntimeLogRuns };
export type { ReadRuntimeLogRunQuery };
