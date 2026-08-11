import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";

export type SubscriptionDiscoveredModel = ModelSelectionSignals & {
  id: string;
  capabilities?: Readonly<Record<string, string>>;
  metadata?: ModelCapabilityMetadata;
  reasoning?: ModelReasoningCapabilities;
};

export type SubscriptionBackendRequestOptions = {
  responseMode?: SubscriptionResponseMode;
  modelCallId?: string;
  onAttribution?: (update: {
    accountAttempt?: { operationId: string; seat: string };
  }) => void;
  attributionOperationId?: string;
};

export type SubscriptionResponseMode = "buffered" | "streaming";

export type SubscriptionProviderTransport = (
  url: string,
  init: RequestInit,
  options?: SubscriptionBackendRequestOptions
) => Promise<Response>;

export type SubscriptionProviderBackend = {
  readonly defaultModel: string | undefined;
  resolveModel?(requested: string | undefined): string | undefined;
  reasoningWireShape?(model: string): string | undefined;
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionBackendRequestOptions
  ): Promise<Response>;
  models(signal?: AbortSignal): Promise<Response>;
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionBackendRequestOptions
  ): Promise<Response>;
};

export type SubscriptionProviderBackendOptions = {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  forceStream?: boolean;
  omitSampling?: boolean;
  transport?: SubscriptionProviderTransport;
};

export type SubscriptionProviderBackendFactory = (
  mode: "claude-code" | "codex",
  options: SubscriptionProviderBackendOptions
) => SubscriptionProviderBackend;
