import {
  decodeModelDiscovery,
  decodeReasoningCapabilities
} from "@velum-labs/routekit-contracts/provider-discovery";
import { Effect } from "effect";
import { gatewayTry, gatewayTryPromise } from "./effect/gateway.js";
import { openaiReasoningCapabilities } from "./openai-reasoning.js";
import { authHeaders, providerCredential, providerMetadata, providerUrl } from "./provider-auth.js";
import { defaultProviderTransport } from "./provider-backend-core.js";
import { createProviderBackend } from "./provider-backend-factory.js";
import type {
  ApiProviderId,
  DiscoveredModel,
  ProviderId,
  ProviderSource,
  ProviderSourceTransport,
  SubscriptionProviderId
} from "./provider-types.js";
import { API_PROVIDER_IDS, PROVIDER_IDS, SUBSCRIPTION_PROVIDER_IDS } from "./provider-types.js";

export type {
  ApiProviderId,
  DiscoveredModel,
  ProviderId,
  ProviderSource,
  ProviderSourceTransport,
  SubscriptionProviderId
};
export {
  API_PROVIDER_IDS,
  decodeModelDiscovery,
  decodeReasoningCapabilities,
  PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS
};

export type ApiProviderSourceOptions = {
  provider: ApiProviderId;
  env?: Readonly<Record<string, string | undefined>>;
  transport?: ProviderSourceTransport;
};

export class ApiProviderSource implements ProviderSource {
  readonly sourceId: ApiProviderId;
  readonly discovery: ProviderSource["discovery"];
  readonly requests: ProviderSource["requests"];
  readonly responses: ProviderSource["responses"];
  readonly capabilities: ProviderSource["capabilities"];
  readonly resource: ProviderSource["resource"];

  constructor(options: ApiProviderSourceOptions) {
    this.sourceId = options.provider;
    const info = providerMetadata(options.provider);
    const env = options.env ?? process.env;
    const credential = providerCredential(options.provider, info, env);
    const baseUrl =
      (info.baseUrlEnv === undefined ? undefined : env[info.baseUrlEnv]) ?? info.baseUrl;
    if (baseUrl === undefined || info.wire === undefined) {
      throw new Error(`provider "${options.provider}" has incomplete registry metadata`);
    }
    const backend = createProviderBackend(info.wire.protocol, {
      baseUrl: providerUrl(baseUrl, info.wire.basePath),
      apiKey: credential,
      headers: info.attributionHeaders ?? {}
    });
    const transport = options.transport ?? defaultProviderTransport;
    this.discovery = {
      discoverModels: (signal) => {
        const discovery = info.discovery;
        if (discovery === undefined) {
          return Effect.fail(
            new Error(`provider "${this.sourceId}" has no model discovery configuration`)
          );
        }
        return transport(providerUrl(baseUrl, discovery.path), {
          headers: {
            accept: "application/json",
            ...authHeaders(discovery.auth, credential),
            ...(discovery.extraHeaders ?? {})
          },
          ...(signal !== undefined ? { signal } : {})
        }).pipe(
          Effect.flatMap((response) => {
            if (!response.ok) {
              return Effect.fail(new Error(`model discovery returned HTTP ${response.status}`));
            }
            return gatewayTryPromise(() => response.json()).pipe(
              Effect.flatMap((payload) =>
                gatewayTry(() =>
                  decodeModelDiscovery(discovery.responseShape, payload, {
                    provider: this.sourceId
                  })
                )
              )
            );
          })
        );
      }
    };
    this.requests = {
      chat: async (body, signal, requestOptions) =>
        await backend.chat(body, signal, requestOptions),
      embeddings: async (body, signal, requestOptions) =>
        await backend.embeddings(body, signal, requestOptions)
    };
    const nativeResponses = backend.ports.responses;
    this.responses =
      this.sourceId === "openai" && nativeResponses.kind === "responses"
        ? {
            kind: "responses",
            supports: (model) => nativeResponses.supports(model),
            execute: async (body, signal, requestOptions) =>
              await nativeResponses.execute(body, signal, requestOptions)
          }
        : { kind: "unsupported" };
    this.capabilities = {
      forModel: () => ({}),
      reasoningForModel: (model) =>
        this.sourceId === "openai" ? openaiReasoningCapabilities(model) : undefined
    };
    const lifecycle = backend.ports.lifecycle;
    this.resource =
      lifecycle.kind === "owned"
        ? { kind: "owned", close: async () => await lifecycle.close() }
        : { kind: "borrowed" };
  }
}
