import { trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import {
  executeWebRequest,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { SubscriptionUsageResponse } from "./wire.js";
import { SUBSCRIPTION_USAGE_PATH, subscriptionUsageResponseSchema } from "./wire.js";

export type SubscriptionProxyClientOptions = {
  /** Base URL of a running RouteKit service (no trailing `/usage`). */
  baseUrl: string;
  /** Bearer token when the service requires authentication. */
  token?: string;
  /** Per-request timeout in milliseconds (default 3000). */
  timeoutMs?: number;
};

/**
 * Typed client for a running subscription proxy. Reads the usage endpoint and
 * parses it through the shared wire schema, so consumers never re-declare the
 * response shape. Errors are surfaced as {@link SubscriptionProxyClientError}.
 */
export class SubscriptionProxyClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  private constructor(options: SubscriptionProxyClientOptions) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 3000;
  }

  static open(options: SubscriptionProxyClientOptions): SubscriptionProxyClient {
    return new SubscriptionProxyClient(options);
  }

  /** Whether the proxy answers its health probe. */
  health(): Effect.Effect<boolean, Error, HttpClient.HttpClient> {
    return this.#get("/health").pipe(
      Effect.map((response) => response.ok),
      Effect.orElseSucceed(() => false)
    );
  }

  /** The live per-account usage snapshot, validated against the wire schema. */
  usage(): Effect.Effect<SubscriptionUsageResponse, Error, HttpClient.HttpClient> {
    return this.#get(SUBSCRIPTION_USAGE_PATH).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(
            new SubscriptionProxyClientError(
              `proxy usage endpoint returned ${response.status}`,
              response.status
            )
          );
        }
        return Effect.tryPromise({
          try: () => response.json(),
          catch: toRouteKitFailure
        }).pipe(
          Effect.flatMap((body) => {
            const parsed = subscriptionUsageResponseSchema.safeParse(body);
            if (!parsed.success) {
              return Effect.fail(
                new SubscriptionProxyClientError(
                  "proxy usage response did not match the wire schema"
                )
              );
            }
            return Effect.succeed(parsed.data);
          })
        );
      })
    );
  }

  #get(path: string) {
    return executeWebRequest(`${this.#baseUrl}${path}`, {
      ...(this.#token !== undefined ? { headers: { authorization: `Bearer ${this.#token}` } } : {}),
      signal: AbortSignal.timeout(this.#timeoutMs)
    }).pipe(Effect.mapError((error) => routeKitError(error)));
  }
}

export class SubscriptionProxyClientError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SubscriptionProxyClientError";
    this.status = status;
  }
}
