import { routeKitError, withAbortSignal } from "@velum-labs/routekit-runtime/effect";
import type { DiscoveredProviderModel } from "@velum-labs/routekit-contracts/provider-discovery";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { Effect } from "effect";

import { SubscriptionProxyClient, type SubscriptionProxyClientOptions } from "../client.js";
import type {
  ConsumeResetCreditInput,
  ConsumeResetCreditResult,
  SubscriptionProvider
} from "../provider.js";
import type {
  AccountLimits,
  ResetCreditSnapshot,
  SubscriptionCredential
} from "../types.js";
import type { SubscriptionUsageResponse } from "../wire.js";

/**
 * Effect façade over a subscription provider's credential and discovery
 * lifecycle. Transport, refresh, and classification policy stay on the
 * existing provider implementation.
 */
export class EffectSubscriptionProvider<M extends SubscriptionMode = SubscriptionMode> {
  readonly #inner: SubscriptionProvider<M>;

  constructor(inner: SubscriptionProvider<M>) {
    this.#inner = inner;
  }

  get inner(): SubscriptionProvider<M> {
    return this.#inner;
  }

  get mode(): M {
    return this.#inner.mode;
  }

  loadCredential(path: string): Effect.Effect<SubscriptionCredential, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.loadCredential(path),
      catch: (cause) => routeKitError(cause)
    });
  }

  discoverModels(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Effect.Effect<readonly DiscoveredProviderModel[], Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: () => this.#inner.discoverModels(credential, signal),
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }

  refresh(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Effect.Effect<SubscriptionCredential, Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: () => this.#inner.refresh(credential, signal),
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }

  fetchUsage(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Effect.Effect<AccountLimits, Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: () => this.#inner.fetchUsage(credential, signal),
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }

  fetchResetCredits(
    credential: SubscriptionCredential,
    signal?: AbortSignal
  ): Effect.Effect<ResetCreditSnapshot, Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: async () => {
          if (this.#inner.fetchResetCredits === undefined) {
            throw new Error(`${this.#inner.mode} does not list reset credits`);
          }
          return await this.#inner.fetchResetCredits(credential, signal);
        },
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }

  consumeResetCredit(
    credential: SubscriptionCredential,
    input: ConsumeResetCreditInput,
    signal?: AbortSignal
  ): Effect.Effect<ConsumeResetCreditResult, Error> {
    return withAbortSignal(
      Effect.tryPromise({
        try: async () => {
          if (this.#inner.consumeResetCredit === undefined) {
            throw new Error(`${this.#inner.mode} does not redeem reset credits`);
          }
          return await this.#inner.consumeResetCredit(credential, input, signal);
        },
        catch: (cause) => routeKitError(cause)
      }),
      signal
    );
  }
}

export function makeEffectSubscriptionProvider<M extends SubscriptionMode>(
  inner: SubscriptionProvider<M>
): EffectSubscriptionProvider<M> {
  return new EffectSubscriptionProvider(inner);
}

/**
 * Effect façade over the typed usage client for a running subscription proxy.
 * Discovery still talks to the live HTTP surface; this only owns interruption.
 */
export class EffectSubscriptionProxyClient {
  readonly #inner: SubscriptionProxyClient;

  constructor(options: SubscriptionProxyClientOptions) {
    this.#inner = SubscriptionProxyClient.open(options);
  }

  get inner(): SubscriptionProxyClient {
    return this.#inner;
  }

  health(): Effect.Effect<boolean, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.health(),
      catch: (cause) => routeKitError(cause)
    });
  }

  usage(): Effect.Effect<SubscriptionUsageResponse, Error> {
    return Effect.tryPromise({
      try: () => this.#inner.usage(),
      catch: (cause) => routeKitError(cause)
    });
  }
}

export function makeEffectSubscriptionProxyClient(
  options: SubscriptionProxyClientOptions
): EffectSubscriptionProxyClient {
  return new EffectSubscriptionProxyClient(options);
}
