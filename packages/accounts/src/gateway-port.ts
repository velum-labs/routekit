import type { IncomingHttpHeaders } from "node:http";

import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";

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
  readonly defaultModel: string | undefined;
  listModelIds?(): readonly string[];
  servesModel?(model: string): boolean;
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionGatewayBackendRequestOptions
  ): Promise<Response>;
  models(signal?: AbortSignal): Promise<Response>;
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: SubscriptionGatewayBackendRequestOptions
  ): Promise<Response>;
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

export type SubscriptionGatewayRelay = {
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
  ): Promise<Response>;
  models?(headers: IncomingHttpHeaders, search: string, signal?: AbortSignal): Promise<Response>;
  countTokens?(
    headers: IncomingHttpHeaders,
    body: SubscriptionAnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response>;
  mergedCatalog?(
    headers: IncomingHttpHeaders,
    search: string
  ): Promise<
    | {
        models: Array<Record<string, unknown>>;
        etag?: string;
      }
    | undefined
  >;
  mergeDataIds?(
    data: Array<{ id: string } & Record<string, unknown>>,
    models: readonly Record<string, unknown>[]
  ): Array<{ id: string } & Record<string, unknown>>;
  close?(): Promise<void> | void;
};

export type SubscriptionGatewayOptions = {
  backend: SubscriptionGatewayBackend;
  host?: string;
  port?: number;
  authToken?: string;
  providerRelays?: Partial<Record<SubscriptionGatewayRelayDialect, SubscriptionGatewayRelay>>;
  usage?: () => unknown | Promise<unknown>;
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
