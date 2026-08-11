import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import {
  API_PROVIDER_IDS,
  PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS
} from "@velum-labs/routekit-config-core";
import type {
  ApiProviderId,
  ProviderId,
  SubscriptionProviderId
} from "@velum-labs/routekit-config-core";

import type { BackendRequestOptions } from "./backend.js";

export { API_PROVIDER_IDS, PROVIDER_IDS, SUBSCRIPTION_PROVIDER_IDS };
export type { ApiProviderId, ProviderId, SubscriptionProviderId };

export type DiscoveredModel = ModelSelectionSignals & {
  id: string;
  capabilities?: Readonly<Record<string, string>>;
  metadata?: ModelCapabilityMetadata;
  reasoning?: ModelReasoningCapabilities;
};

export type ProviderSource = {
  readonly sourceId: ProviderId;
  discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): Promise<Response>;
  supportsResponses?(model: string): boolean;
  responses?(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
  capabilities?(model: string): Readonly<Record<string, string>>;
  reasoningCapabilities?(model: string): ModelReasoningCapabilities | undefined;
  close?(): Promise<void> | void;
};

export type ProviderSourceTransport = (url: string, init: RequestInit) => Promise<Response>;
