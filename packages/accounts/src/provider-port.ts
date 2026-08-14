import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import type { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

export type SubscriptionBackendRequestOptions = {
  responseMode?: SubscriptionResponseMode;
  modelCallId?: string;
  onAttribution?: (update: { accountAttempt?: { operationId: string; seat: string } }) => void;
  attributionOperationId?: string;
};

export type SubscriptionResponseMode = "buffered" | "streaming";

export type SubscriptionProviderTransport = (
  url: string,
  init: RequestInit,
  options?: SubscriptionBackendRequestOptions
) => Effect.Effect<Response, Error, RouteKitPlatform>;

export type SubscriptionProviderBackend = {
  readonly defaultModel: string | undefined;
  resolveModel?(requested: string | undefined): string | undefined;
  reasoningWireShape?(model: string): string | undefined;
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionBackendRequestOptions
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  models(signal?: AbortSignal): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionBackendRequestOptions
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
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
