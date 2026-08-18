import type { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

/** True when an HTTP response status is in the 2xx success range. */
export const isOkStatus = (status: number): boolean =>
  status >= HTTP_OK_MIN && status < HTTP_OK_MAX;

/** The response body as text, or empty when the body cannot be read. */
export const readHttpResponseText = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string> => response.text.pipe(Effect.orElseSucceed(() => ""));

/**
 * A `fetch` that delegates to the current `globalThis.fetch` on every call,
 * rather than capturing it once at module-load time.
 *
 * The Effect fetch client resolves its `Fetch` implementation eagerly when the
 * layer is built. Capturing `globalThis.fetch` by reference at that moment would
 * freeze whichever function was installed then — but the test suites swap
 * `globalThis.fetch` per-test (see e.g. `chat-test-support.ts` and
 * `command-test-support.ts`). Delegating on each call keeps those runtime swaps
 * honored while still routing every network request through the injectable
 * `HttpClient` service — the real DI seam that production and future tests
 * consume via {@link fetchHttpClientLayer}.
 */
export const currentGlobalFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
  {
    preconnect: (...args: unknown[]) => {
      const preconnect = (
        globalThis.fetch as { preconnect?: (...preconnectArgs: unknown[]) => void }
      ).preconnect;
      preconnect?.(...args);
    },
  },
) as typeof fetch;

/**
 * The canonical fetch-backed transport layer: `FetchHttpClient.layer` with its
 * `Fetch` reference pinned to {@link currentGlobalFetch}.
 *
 * This is the single wiring point every composition root provides once to
 * discharge the `HttpClient` requirement of everything below it. The `Fetch` pin
 * rides as a `Layer.succeed` fed into the fetch layer, matching Effect's own
 * recommended form for supplying a custom fetch to `FetchHttpClient.layer`, and
 * `currentGlobalFetch` keeps the `globalThis.fetch` test seam working.
 */
export const fetchHttpClientLayer: Layer.Layer<HttpClient.HttpClient> =
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, currentGlobalFetch))
  );
