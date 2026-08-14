import type { IncomingHttpHeaders } from "node:http";

import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import type { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

export type SubscriptionGatewayBackendRequestOptions = {
  responseMode?: "buffered" | "streaming";
  modelCallId?: string;
  reasoningCapabilities?: ModelReasoningCapabilities;
  onAttribution?: (update: { accountAttempt?: { operationId: string; seat: string } }) => void;
  attributionOperationId?: string;
  requestContext?: {
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  };
  translated?: boolean;
};

export type SubscriptionGatewayBackend = {
  readonly ports: {
    readonly models: Readonly<{
      kind: "static-model";
      list(): readonly string[];
      resolve(requested: string | undefined): string | undefined;
      resolveRoute(requested: string | undefined, nativeProvider?: string): undefined;
      serves(model: string): boolean;
      capabilities(model: string): Readonly<Record<string, string>>;
      metadata(model: string): undefined;
      reasoning(model: string): ModelReasoningCapabilities | undefined;
      reasoningWireShape(model: string): string | undefined;
    }>;
    readonly responses: Readonly<{ kind: "unsupported" }>;
    readonly lifecycle: Readonly<{ kind: "borrowed" }>;
  };
  readonly defaultModel: string | undefined;
  listModelIds?(): readonly string[];
  servesModel?(model: string): boolean;
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionGatewayBackendRequestOptions
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  models(signal?: AbortSignal): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionGatewayBackendRequestOptions
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
  close?(): Promise<void> | void;
};

export type SubscriptionAnthropicRequest = {
  model?: string;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type SubscriptionResponsesRequest = {
  model?: string;
  [key: string]: unknown;
};

export type SubscriptionGatewayRelayDialect = "anthropic" | "codex";

export type SubscriptionGatewayRequestRelay = {
  readonly kind: "request";
  readonly dialect: SubscriptionGatewayRelayDialect;
  shouldRelay(
    headers: IncomingHttpHeaders,
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: IncomingHttpHeaders,
    body: SubscriptionAnthropicRequest | SubscriptionResponsesRequest,
    signal?: AbortSignal,
    options?: Pick<SubscriptionGatewayBackendRequestOptions, "onAttribution" | "responseMode">
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
};

export type SubscriptionGatewayModelCatalogRelay =
  | {
      readonly kind: "models";
      readonly dialect: "anthropic";
      models(
        headers: IncomingHttpHeaders,
        search: string,
        signal?: AbortSignal
      ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
    }
  | {
      readonly kind: "merged-models";
      readonly dialect: "codex";
      mergedCatalog(
        headers: IncomingHttpHeaders,
        search: string
      ): Effect.Effect<
        | {
            models: Array<Record<string, unknown>>;
            etag?: string;
          }
        | undefined,
        Error,
        HttpClient.HttpClient
      >;
      mergeDataIds(
        data: Array<{ id: string } & Record<string, unknown>>,
        models: readonly Record<string, unknown>[]
      ): Array<{ id: string } & Record<string, unknown>>;
    };

export type SubscriptionGatewayTokenCountRelay = {
  readonly kind: "token-count";
  readonly dialect: "anthropic";
  countTokens(
    headers: IncomingHttpHeaders,
    body: SubscriptionAnthropicRequest,
    signal?: AbortSignal
  ): Effect.Effect<Response, Error, HttpClient.HttpClient>;
};

export type SubscriptionGatewayRelayLifecycle = {
  readonly kind: "lifecycle";
  close(): Effect.Effect<void, Error, HttpClient.HttpClient>;
};

export type SubscriptionGatewayRelayPorts = Readonly<{
  request: SubscriptionGatewayRequestRelay & {
    snapshot?(): import("./types.js").SubscriptionAccountSetSnapshot | undefined;
  };
  catalog?: SubscriptionGatewayModelCatalogRelay;
  tokenCount?: SubscriptionGatewayTokenCountRelay;
  lifecycle?: SubscriptionGatewayRelayLifecycle;
}>;

export type SubscriptionGatewayOptions = {
  backend: SubscriptionGatewayBackend;
  host?: string;
  port?: number;
  authToken?: string;
  providerRelays?: Partial<Record<SubscriptionGatewayRelayDialect, SubscriptionGatewayRelayPorts>>;
  usage?: () => Effect.Effect<unknown, Error, HttpClient.HttpClient>;
};

export type SubscriptionGateway = {
  url(): string;
  port(): number;
  drain(graceMs?: number): Promise<void>;
  close(): Promise<void>;
};

/** Explicit composition seam supplied by a gateway host. */
export type SubscriptionGatewayFactory = (
  options: SubscriptionGatewayOptions
) => Promise<SubscriptionGateway>;
