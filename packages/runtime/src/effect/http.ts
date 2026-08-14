import { Effect } from "effect";
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";

import { withAbortSignal } from "./abort-signal.js";

const HTTP_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function headerRecord(headers?: RequestInit["headers"] | Headers): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function withBody(
  request: HttpClientRequest.HttpClientRequest,
  body: RequestInit["body"],
  contentType: string | undefined
): HttpClientRequest.HttpClientRequest {
  if (body === undefined || body === null) return request;
  if (typeof body === "string") {
    return HttpClientRequest.setBody(
      request,
      HttpBody.raw(body, contentType === undefined ? {} : { contentType })
    );
  }
  const bytes =
    body instanceof Uint8Array
      ? body
      : typeof Buffer !== "undefined" && Buffer.isBuffer(body)
        ? body
        : undefined;
  if (bytes !== undefined) {
    return HttpClientRequest.setBody(
      request,
      HttpBody.raw(bytes, contentType === undefined ? {} : { contentType })
    );
  }
  if (body instanceof URLSearchParams) {
    return HttpClientRequest.setBody(
      request,
      HttpBody.raw(body.toString(), { contentType: "application/x-www-form-urlencoded" })
    );
  }
  throw new TypeError(
    `unsupported HttpClient request body: ${Object.prototype.toString.call(body)}`
  );
}

/**
 * Execute an outbound HTTP request through Effect `HttpClient` and return the
 * backing Fetch `Response` without buffering the body.
 *
 * FetchHttpClient wraps the web `Response` as `source`. Dialect translators and
 * `StreamPump` keep consuming that Fetch `Response` until a Stream conversion
 * is proven byte-identical.
 *
 * Pass `init.signal` (or wrap with `withAbortSignal`) to abort; fiber
 * interruption also aborts the in-flight request.
 */
export function executeWebRequest(
  input: string | URL | Request,
  init?: RequestInit
): Effect.Effect<Response, HttpClientError.HttpClientError, HttpClient.HttpClient> {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = headerRecord(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  const body = init?.body;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (!HTTP_METHODS.has(method)) {
    return Effect.die(new TypeError(`unsupported HTTP method: ${method}`));
  }
  const request = withBody(
    HttpClientRequest.make(method as HttpMethod)(url, { headers }),
    body,
    headers["content-type"]
  );
  return withFetchInit(
    withAbortSignal(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(request);
        return fetchResponseFromClient(response);
      }),
      signal ?? undefined
    ),
    init
  );
}

function withFetchInit<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  init?: RequestInit
): Effect.Effect<A, E, R> {
  if (init?.redirect === undefined) return effect;
  return effect.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: init.redirect })
  );
}

const pinnedClientResponses = new WeakMap<Response, unknown>();

function clientResponseSource(response: HttpClientResponse): unknown {
  const original = (response as { original?: HttpClientResponse }).original ?? response;
  return (original as { source?: unknown }).source;
}

export function fetchResponseFromClient(response: HttpClientResponse): Response {
  const source = clientResponseSource(response);
  const web =
    source instanceof Response
      ? source
      : typeof source === "object" &&
          source !== null &&
          "status" in source &&
          typeof (source as Response).clone === "function"
        ? (source as Response)
        : undefined;
  if (web === undefined) {
    throw new TypeError("HttpClient response is not backed by a Fetch Response");
  }
  // HttpClient registers the inner response with a FinalizationRegistry that
  // aborts the request. Pin it to the Fetch Response so streaming bodies stay
  // alive after runPromise returns.
  pinnedClientResponses.set(web, (response as { original?: unknown }).original ?? response);
  return web;
}
