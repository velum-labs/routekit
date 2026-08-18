import type { HttpClientResponse } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";

import { Effect, Option, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { OriError } from "../../../../../contracts/internal/src/errors.ts";

import { RuntimeClientError } from "../../../../../contracts/internal/src/errors.ts";
import { isOkStatus } from "../../../../../contracts/internal/src/http-client.ts";
import { decodeDaemonErrorFailure } from "../../../../../contracts/internal/src/runtime/daemon-error.ts";

/**
 * Request shape for {@link fetchRuntimeResponse}. Only the method and (optional)
 * headers vary across the daemon client; request bodies, when present, are built
 * by the individual POST call sites. Kept as a narrow structural type so the
 * helper stays transport-agnostic.
 */
export interface RuntimeRequestInit {
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A bodyless JSON POST — daemon routes match on method + path, not body. */
export const JSON_POST_INIT: RuntimeRequestInit = {
  headers: { "content-type": "application/json" },
  method: "POST",
};

export interface RuntimeClientOptions {
  readonly host: string;
  readonly port: number;
}

export const makeRuntimeUrl = (
  options: RuntimeClientOptions,
  path: string
): string => `http://${options.host}:${options.port}${path}`;

interface DaemonErrorParts {
  readonly summary: string;
  readonly cause?: OriError;
}

/**
 * Resolve a daemon error response body into a human summary plus, when the
 * daemon attached a structured `failure`, the reconstructed tagged error to
 * carry as the client error's `cause`. Plain-text or non-envelope bodies fall
 * back to the raw body as the summary with no cause, so callers keep their
 * existing string detail.
 */
export const readDaemonError = (
  body: string
): Effect.Effect<DaemonErrorParts> =>
  decodeDaemonErrorFailure(body).pipe(
    Effect.map((failure) =>
      Option.isSome(failure)
        ? {
            cause: failure.value,
            summary: failure.value.message,
          }
        : { summary: body }
    )
  );

export const makeRuntimeClientErrorFromCause =
  (detail: string) =>
  (cause: unknown): RuntimeClientError =>
    new RuntimeClientError({
      cause,
      detail,
    });

const DEFAULT_METHOD: HttpMethod = "GET";

/**
 * Execute a request against the local Ori runtime through the injectable
 * `HttpClient`, mapping any transport failure to a `RuntimeClientError`.
 * `HttpClient` surfaces in the requirement channel of every consumer; a
 * composition root (the CLI root for command reads, the Promise boundary for
 * the bare-runtime callers) provides the fetch transport.
 */
export const fetchRuntimeResponse = Effect.fn("RuntimeClient.fetchResponse")(
  function* (
    options: RuntimeClientOptions,
    path: string,
    init?: RuntimeRequestInit
  ) {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(init?.method ?? DEFAULT_METHOD)(
      makeRuntimeUrl(options, path),
      init?.headers === undefined ? {} : { headers: init.headers }
    );
    return yield* client.execute(request);
  },
  (effect, options) =>
    effect.pipe(
      Effect.mapError(
        makeRuntimeClientErrorFromCause(
          `Could not reach local Ori runtime at ${makeRuntimeUrl(options, "")}`
        )
      )
    )
);

export const fetchRuntimeHealth = (
  options: RuntimeClientOptions
): Effect.Effect<void, RuntimeClientError, HttpClient.HttpClient> =>
  fetchRuntimeResponse(options, "/health").pipe(
    Effect.andThen((response) =>
      isOkStatus(response.status)
        ? Effect.void
        : new RuntimeClientError({
            detail: `Health check failed with HTTP ${response.status} at ${makeRuntimeUrl(options, "/health")}`,
          })
    )
  );

export const readResponseText = (
  options: RuntimeClientOptions,
  path: string,
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string, RuntimeClientError> =>
  response.text.pipe(
    Effect.mapError(
      makeRuntimeClientErrorFromCause(
        `Failed to read local Ori runtime response at ${makeRuntimeUrl(options, path)}`
      )
    )
  );

/**
 * Decode a runtime NDJSON byte stream into trimmed, non-empty lines. Shared by
 * every daemon line-stream consumer (invoke events, schedule dispatch, log
 * tails) so they use one identical byte→text→line pipeline. The response body
 * is read via {@link HttpClientResponse} `stream`, so backpressure and
 * cancellation propagate through Effect's `Stream` rather than a raw reader.
 */
export const decodeRuntimeNdjsonLines = <E>(
  bytes: Stream.Stream<Uint8Array, E>
): Stream.Stream<string, E> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0)
  );
