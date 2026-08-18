import { Effect, Option, Stream } from "effect";

import type { ReadDevLogRunOptions } from "../../dev/log-store.ts";

import { encodeJsonStringSync } from "../../../../../contracts/internal/src/json.ts";
import { DevEventLogEntrySchema } from "../../../../../contracts/internal/src/runtime/dev-event-log.ts";
import { RuntimeJournalEntrySchema } from "../../../../../contracts/internal/src/runtime/journal-entry.ts";
import { journalEntrySessionId } from "../../../../../contracts/internal/src/runtime/journal-entry-session.ts";
import { RuntimeEventJournal } from "../../../../../engine/events/src/event-journal-service.ts";
import {
  makeJsonResponse,
  NOT_FOUND_STATUS,
} from "../core/http-response.ts";
import { DaemonLogHub } from "./log-hub.ts";
import { DevLogStore } from "../../dev/log-store.ts";

// This module owns ONLY the daemon's streaming surfaces (NDJSON event tail,
// per-run NDJSON tail, text/plain log tail). Every unary read that used to live
// here — `/api/sessions*`, `/api/events`, `/api/logs/runs` list — moved to the
// consolidated daemon HttpApi (daemon-http/*); HttpApi v4 cannot model these
// streams, so they stay raw and are matched before that mount. Colocated (rather
// than inlined in daemon-server.ts) so the server module's import fan-out stays
// under the architecture budget.

const LOGS_RUNS_PATH = "/api/logs/runs";
const LOGS_RUN_PATH_PREFIX = `${LOGS_RUNS_PATH}/`;
const FOLLOW_QUERY_VALUE = "true";

const NDJSON_RESPONSE_HEADERS = {
  "cache-control": "no-cache",
  "content-type": "application/x-ndjson; charset=utf-8",
} as const;

// Both tails serialize through the schema that already governs the value rather
// than raw `JSON.stringify`, so a value that drifts from its contract fails
// loudly at the boundary instead of shipping malformed NDJSON to the client.
// `Schema.fromJsonString` encodes compact JSON, so the bytes match what
// `JSON.stringify` emitted. The encoders are built once at module load; per
// entry only the encode runs.
const encodeJournalEntryLine = encodeJsonStringSync(RuntimeJournalEntrySchema);
const encodeDevEventLogLine = encodeJsonStringSync(DevEventLogEntrySchema);

/**
 * The live `/api/events/stream` NDJSON tail, with an optional `?sessionId=`
 * filter (Fork Thread, RFC 0003 / RFC 0008). The filter is applied to the live
 * tail, so swapping the foreground thread is a reconnect with a new sessionId;
 * background siblings keep streaming. The unary `/api/events` read moved to the
 * daemon HttpApi. Returns `undefined` for other paths so the caller falls
 * through.
 */
const matchEventStreamRoute = Effect.fn("RuntimeHttp.eventStreamRoute")(
  function* (url: URL) {
    if (url.pathname !== "/api/events/stream") {
      return;
    }
    const journal = yield* RuntimeEventJournal;
    const sessionFilter = url.searchParams.get("sessionId");
    const tail =
      sessionFilter === null
        ? journal.tail
        : journal.tail.pipe(
            Stream.filter(
              (entry) => journalEntrySessionId(entry) === sessionFilter
            )
          );
    return new Response(
      Stream.toReadableStream(
        tail.pipe(
          Stream.map((entry) => `${encodeJournalEntryLine(entry)}\n`),
          Stream.encodeText
        )
      ),
      { headers: NDJSON_RESPONSE_HEADERS }
    );
  }
);

const parseLogRunQuery = (url: URL): ReadDevLogRunOptions => {
  const sessionId = url.searchParams.get("sessionId");
  const type = url.searchParams.get("type");
  return {
    follow: url.searchParams.get("follow") === FOLLOW_QUERY_VALUE,
    ...(sessionId === null ? {} : { sessionId }),
    ...(type === "log" || type === "runtime.event" ? { type } : {}),
  };
};

// The id is resolved (incl. the `latest` alias) before opening the stream so
// unknown ids answer 404 cleanly; reads go through `DevLogStore`/disk, never
// the daemon's own streaming endpoints (a loopback subscription would block
// graceful shutdown).
const handleLogRunRequest = Effect.fn("RuntimeHttp.handleLogRun")(function* (
  url: URL
) {
  const store = yield* DevLogStore;
  const runId = decodeURIComponent(
    url.pathname.slice(LOGS_RUN_PATH_PREFIX.length)
  );
  const resolved = yield* store.resolve(runId);
  if (Option.isNone(resolved)) {
    return makeJsonResponse({ error: "Run not found" }, NOT_FOUND_STATUS);
  }

  const stream = store.read(resolved.value, parseLogRunQuery(url)).pipe(
    Stream.map((entry) => `${encodeDevEventLogLine(entry)}\n`),
    Stream.encodeText
  );

  return new Response(Stream.toReadableStream(stream), {
    headers: NDJSON_RESPONSE_HEADERS,
  });
});

/**
 * The per-run NDJSON tail (`GET /api/logs/runs/:id`, RFC 0004 — dev), with the
 * `sessionId`/`type`/`follow` filters the CLI exposes. Matched only for the
 * `:id` form; the `/api/logs/runs` list moved to the daemon HttpApi, so this
 * matcher must run AFTER the mount has had its chance (find-my-way won't match
 * `/api/logs/runs/dev-1` to the list endpoint's exact `/api/logs/runs`, so the
 * tail cleanly falls through to here). Returns `undefined` for other paths.
 */
const matchLogRunTailRoute = Effect.fn("RuntimeHttp.logRunTailRoute")(
  function* (method: string, url: URL) {
    if (method !== "GET" || !url.pathname.startsWith(LOGS_RUN_PATH_PREFIX)) {
      return;
    }
    return yield* handleLogRunRequest(url);
  }
);

/** Tail the daemon log hub as a `text/plain` stream (`GET /api/logs/stream`). */
const matchLogStreamRoute = Effect.fn("RuntimeHttp.logStreamRoute")(function* (
  url: URL
) {
  if (url.pathname !== "/api/logs/stream") {
    return;
  }
  const hub = yield* DaemonLogHub;
  return new Response(
    Stream.toReadableStream(
      hub.tail.pipe(
        Stream.map((line) => `${line}\n`),
        Stream.encodeText
      )
    ),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/plain; charset=utf-8",
      },
    }
  );
});

export { matchEventStreamRoute, matchLogRunTailRoute, matchLogStreamRoute };
