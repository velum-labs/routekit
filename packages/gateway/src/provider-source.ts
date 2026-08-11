import type { ProviderInfo } from "@velum-labs/routekit-registry";

import {
  backendPorts,
  type Backend,
  type BackendRequestOptions
} from "./backend.js";
import { authHeaders, providerCredential, providerMetadata, providerUrl } from "./provider-auth.js";
import { createProviderBackend } from "./provider-backend-factory.js";
import { parseDiscoveredModels, parseReasoningCapabilities } from "./provider-model-codecs.js";
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
  PROVIDER_IDS,
  parseDiscoveredModels,
  parseReasoningCapabilities,
  SUBSCRIPTION_PROVIDER_IDS
};

export type ApiProviderSourceOptions = {
  provider: ApiProviderId;
  env?: Readonly<Record<string, string | undefined>>;
  transport?: ProviderSourceTransport;
};

export class ApiProviderSource implements ProviderSource {
  readonly sourceId: ApiProviderId;
  readonly #info: ProviderInfo;
  readonly #baseUrl: string;
  readonly #credential: string;
  readonly #backend: Backend;
  readonly #transport: ProviderSourceTransport;

  constructor(options: ApiProviderSourceOptions) {
    this.sourceId = options.provider;
    this.#info = providerMetadata(options.provider);
    const env = options.env ?? process.env;
    this.#credential = providerCredential(options.provider, this.#info, env);
    const baseUrl =
      (this.#info.baseUrlEnv === undefined ? undefined : env[this.#info.baseUrlEnv]) ??
      this.#info.baseUrl;
    if (baseUrl === undefined || this.#info.wire === undefined) {
      throw new Error(`provider "${options.provider}" has incomplete registry metadata`);
    }
    this.#baseUrl = baseUrl;
    this.#backend = createProviderBackend(this.#info.wire.protocol, {
      baseUrl: providerUrl(this.#baseUrl, this.#info.wire.basePath),
      apiKey: this.#credential,
      headers: this.#info.attributionHeaders ?? {}
    });
    this.#transport = options.transport ?? (async (url, init) => await fetch(url, init));
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
    const discovery = this.#info.discovery;
    if (discovery === undefined) {
      throw new Error(`provider "${this.sourceId}" has no model discovery configuration`);
    }
    const response = await this.#transport(providerUrl(this.#baseUrl, discovery.path), {
      headers: {
        accept: "application/json",
        ...authHeaders(discovery.auth, this.#credential),
        ...(discovery.extraHeaders ?? {})
      },
      ...(signal !== undefined ? { signal } : {})
    });
    if (!response.ok) {
      throw new Error(`model discovery returned HTTP ${response.status}`);
    }
    return parseDiscoveredModels(discovery.responseShape, await response.json(), this.sourceId);
  }

  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): Promise<Response> {
    return this.#backend.chat(body, signal, options);
  }

  supportsResponses(model: string): boolean {
    const responses = backendPorts(this.#backend).responses;
    return this.sourceId === "openai" && responses.kind === "responses" && responses.supports(model);
  }

  responses(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const responses = backendPorts(this.#backend).responses;
    if (responses.kind === "unsupported") {
      return Promise.resolve(
        Response.json(
          { error: { type: "not_supported", message: "native Responses egress is not supported" } },
          { status: 501 }
        )
      );
    }
    return responses.execute(body, signal, options);
  }

  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return this.#backend.embeddings(body, signal, options);
  }

  close(): Promise<void> | void {
    const lifecycle = backendPorts(this.#backend).lifecycle;
    return lifecycle.kind === "owned" ? lifecycle.close() : undefined;
  }
}
