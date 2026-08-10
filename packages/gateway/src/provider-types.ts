import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";

import type { BackendRequestOptions } from "./backend.js";

export const API_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "bedrock",
  "google",
  "openrouter",
  "cliproxy"
] as const;

export const SUBSCRIPTION_PROVIDER_IDS = ["codex", "claude-code"] as const;
export const PROVIDER_IDS = [...API_PROVIDER_IDS, ...SUBSCRIPTION_PROVIDER_IDS] as const;

export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];
export type ProviderId = (typeof PROVIDER_IDS)[number];

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
