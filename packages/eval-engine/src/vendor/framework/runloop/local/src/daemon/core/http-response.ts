// Lives apart from `daemon-server.ts` so the route modules it splits out (e.g.
// `daemon-log-routes.ts`) can build responses without importing the server back
// (which would form a cycle).
import { Duration, Stream } from "effect";

const NDJSON_HEADERS = {
  "cache-control": "no-cache",
  "content-type": "application/x-ndjson; charset=utf-8",
} as const;

// A turn parked in one long tool call emits nothing between `tool.started` and
// the tool's result, and Bun's `fetch` drops a response body that goes 300s
// without bytes — so a `sleep 400` killed the turn with an opaque decode error
// while the daemon was still healthy. A blank keepalive line keeps the body
// live and, unlike disabling the client timeout, preserves the timeout as a
// real liveness check: silence now means the daemon genuinely stopped.
// Blank lines are inert for every consumer — `decodeRuntimeNdjsonLines` and the
// generated eval SDK both drop empty lines before parsing.
const HEARTBEAT_SECONDS = 30;
const HEARTBEAT_INTERVAL = Duration.seconds(HEARTBEAT_SECONDS);
const HEARTBEAT_LINE = "\n";

// `Stream.tick` fires once immediately; dropping that tick keeps the very first
// byte of the body a real payload line rather than a blank.
const heartbeat = (interval: Duration.Input): Stream.Stream<string> =>
  Stream.tick(interval).pipe(
    Stream.drop(1),
    Stream.map(() => HEARTBEAT_LINE)
  );

export const OK_STATUS = 200;
export const BAD_REQUEST_STATUS = 400;
export const NOT_FOUND_STATUS = 404;
export const METHOD_NOT_ALLOWED_STATUS = 405;
export const INTERNAL_ERROR_STATUS = 500;

export const makeJsonResponse = (
  body: unknown,
  status: number = OK_STATUS
): Response =>
  Response.json(body, {
    status,
  });

/**
 * Wrap a string stream as an NDJSON SSE `Response` (UTF-8 encoded, no-cache),
 * interleaving a blank keepalive line every {@link HEARTBEAT_INTERVAL} so a
 * quiet stream never looks like a dead connection. `haltStrategy: "left"` ends
 * the response with the source stream; the endless heartbeat never holds it open.
 */
export const makeNdjsonStreamResponse = <E>(
  lines: Stream.Stream<string, E>,
  interval: Duration.Input = HEARTBEAT_INTERVAL
): Response =>
  new Response(
    Stream.toReadableStream(
      Stream.merge(lines, heartbeat(interval), { haltStrategy: "left" }).pipe(
        Stream.encodeText
      )
    ),
    {
      headers: NDJSON_HEADERS,
    }
  );
