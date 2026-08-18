import type {
  ApiProviderId,
  ProviderId,
  SubscriptionProviderId
} from "@velum-labs/routekit-config-core";
import {
  API_PROVIDER_IDS,
  PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS
} from "@velum-labs/routekit-config-core";
import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import type { DiscoveredProviderModel } from "@velum-labs/routekit-contracts/provider-discovery";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import type { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { BackendRequest, BackendRequestOptions } from "./backend.js";

export type { ApiProviderId, ProviderId, SubscriptionProviderId };
export { API_PROVIDER_IDS, PROVIDER_IDS, SUBSCRIPTION_PROVIDER_IDS };

export type DiscoveredModel = DiscoveredProviderModel;

export type ProviderModelDiscovery = {
  discoverModels(
    signal?: AbortSignal
  ): Effect.Effect<readonly DiscoveredModel[], Error, RouteKitPlatform>;
};

export type ProviderRequestExecutor = {
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
  embeddings(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
};

export type ProviderResponsesExecutor =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "responses";
      supports(model: string): boolean;
      execute(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
    }>;

export type ProviderCapabilities = {
  forModel(model: string): Readonly<Record<string, string>>;
  reasoningForModel(model: string): ModelReasoningCapabilities | undefined;
};

export type ProviderResource =
  | Readonly<{ kind: "borrowed" }>
  | Readonly<{ kind: "owned"; close: Effect.Effect<void, Error, RouteKitPlatform> }>;

export type ProviderSource = {
  readonly sourceId: ProviderId;
  readonly discovery: ProviderModelDiscovery;
  readonly requests: ProviderRequestExecutor;
  readonly responses: ProviderResponsesExecutor;
  readonly capabilities: ProviderCapabilities;
  readonly resource: ProviderResource;
};

export type ProviderSourceTransport = (
  url: string,
  init: RequestInit
) => Effect.Effect<Response, Error, HttpClient.HttpClient>;
