import { Effect } from "effect";
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";

import { withAbortSignal } from "./abort-signal.js";
import { type RouteKitManagedRuntime, runRouteKitEffect } from "./effect-runtime.js";

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
  return withAbortSignal(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(request);
      return fetchResponseFromClient(response);
    }),
    signal ?? undefined
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

/**
 * Promise edge over {@link executeWebRequest} using the process-lifetime
 * runtime so streaming bodies outlive the call that received headers.
 */
export function fetchViaHttpClient(
  input: string | URL | Request,
  init?: RequestInit,
  runtime?: RouteKitManagedRuntime
): Promise<Response> {
  return runRouteKitEffect(executeWebRequest(input, init), runtime);
}
