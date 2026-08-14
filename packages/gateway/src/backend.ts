/**
 * Gateway backend ports and the model-routed dispatcher. Provider HTTP
 * transports live next to their codecs (`openai-backend.ts`,
 * `anthropic-backend.ts`, `google-backend.ts`, `codex-responses-backend.ts`).
 */
import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  RequestAttribution
} from "@velum-labs/routekit-contracts";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { type Context, Effect } from "effect";

export type BackendModelRoute = {
  /** Stable RouteKit catalog id (`provider/model`). */
  publicId: string;
  /** Model id understood by the provider's native API. */
  nativeId: string;
  /** Configured provider that owns the model. */
  provider: string;
  metadata?: ModelCapabilityMetadata;
  reasoning?: ModelReasoningCapabilities;
};

type BackendModelOperations = Readonly<{
  list(): readonly string[];
  resolve(requested: string | undefined): string | undefined;
  resolveRoute(
    requested: string | undefined,
    nativeProvider?: string
  ): BackendModelRoute | undefined;
  serves(model: string): boolean;
  capabilities(model: string): Readonly<Record<string, string>>;
  metadata(model: string): ModelCapabilityMetadata | undefined;
  reasoning(model: string): ModelReasoningCapabilities | undefined;
  reasoningWireShape(model: string): string | undefined;
}>;

export type BackendModelPort =
  | (BackendModelOperations & Readonly<{ kind: "static-model" }>)
  | (BackendModelOperations & Readonly<{ kind: "model-catalog" }>);

export type BackendResponsesPort =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "responses";
      supports(model: string): boolean;
      execute(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
    }>;

export type BackendLifecyclePort =
  | Readonly<{ kind: "borrowed" }>
  | Readonly<{ kind: "owned"; close(): Promise<void> | void }>;

export type BackendPorts = Readonly<{
  models: BackendModelPort;
  responses: BackendResponsesPort;
  lifecycle: BackendLifecyclePort;
}>;

export function staticBackendModelPort(
  defaultModel: string | undefined,
  options: Readonly<{
    reasoningWireShape?: string;
    responses?: boolean;
  }> = {}
): BackendModelPort {
  return {
    kind: "static-model",
    list: () => (defaultModel === undefined ? [] : [defaultModel]),
    resolve: () => defaultModel,
    resolveRoute: () => undefined,
    serves: (model) => defaultModel === undefined || model === defaultModel,
    capabilities: () => ({}),
    metadata: () => undefined,
    reasoning: () => undefined,
    reasoningWireShape: () => options.reasoningWireShape
  };
}

export function borrowedBackendPorts(
  defaultModel: string | undefined,
  overrides: Readonly<{
    models?: BackendModelPort;
    responses?: BackendResponsesPort;
    lifecycle?: BackendLifecyclePort;
  }> = {}
): BackendPorts {
  return {
    models: overrides.models ?? staticBackendModelPort(defaultModel),
    responses: overrides.responses ?? { kind: "unsupported" },
    lifecycle: overrides.lifecycle ?? { kind: "borrowed" }
  };
}

/** Provider HTTP I/O. Callers yield this on a fiber that already has HttpClient. */
export type BackendRequest = Effect.Effect<Response, Error, RouteKitPlatform>;

export type Backend = {
  /** Explicit capability and ownership ports. */
  ports: BackendPorts;
  /** Model id sent to the backend when a request omits one. */
  readonly defaultModel: string | undefined;
  /** POST <base>/chat/completions — supports streaming (SSE) upstream. */
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
  /** GET <base>/models. */
  models(signal?: AbortSignal): BackendRequest;
  /** POST <base>/embeddings. */
  embeddings(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest;
};

export type BackendResponseMode = "buffered" | "streaming";

export type BackendRequestOptions = {
  /** Original downstream response mode, before any provider forces upstream SSE. */
  responseMode?: BackendResponseMode;
  modelCallId?: string;
  reasoningCapabilities?: ModelReasoningCapabilities;
  /** Request-local, sanitized attribution updates from routing/backends. */
  onAttribution?: (update: RequestAttributionUpdate) => void;
  /** Distinguishes compound provider operations within one public request. */
  attributionOperationId?: string;
  /**
   * Neutral request context captured at the HTTP boundary. Backends may
   * interpret their own namespaced headers; the gateway does not.
   */
  requestContext?: {
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  };
  /**
   * The caller will wrap the returned stream in a dialect translator
   * (Anthropic / Responses) that emits its own keepalive.
   */
  translated?: boolean;
  /**
   * HttpClient context captured when the gateway HTTP app was built.
   * Server-tool search I/O reuses it instead of a nested runtime.
   */
  platform?: Context.Context<RouteKitPlatform>;
};

export type RequestAttributionUpdate = Partial<RequestAttribution> & {
  accountAttempt?: {
    operationId: string;
    seat: string;
  };
};

/** Join a base URL (which may end in `/`) with a route path. */
export function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export type ModelRoutedBackendOptions = {
  /** Requested model ids served by `routed` instead of the primary backend. */
  routedModelIds: readonly string[];
  /** Backend for the routed ids. */
  routed: Backend;
  /** Backend for everything else (e.g. the member's router endpoint). */
  primary: Backend;
};

/**
 * A backend that dispatches by requested model id: ids in `routedModelIds` go
 * to the `routed` backend, everything else to `primary`. This lets selected
 * model ids use a secondary destination.
 */
export class ModelRoutedBackend implements Backend {
  readonly #routedIds: ReadonlySet<string>;
  readonly #routed: Backend;
  readonly #primary: Backend;
  readonly defaultModel: string | undefined;
  readonly ports: BackendPorts;

  constructor(options: ModelRoutedBackendOptions) {
    this.#routedIds = new Set(options.routedModelIds);
    this.#routed = options.routed;
    this.#primary = options.primary;
    this.defaultModel = options.primary.defaultModel;
    this.ports = {
      models: {
        kind: "model-catalog",
        list: () => this.listModelIds(),
        resolve: (requested) => this.resolveModel(requested),
        resolveRoute: (requested, nativeProvider) =>
          this.#backendFor(requested).ports.models.resolveRoute(requested, nativeProvider),
        serves: (model) => this.#routedIds.has(model) || this.#primary.ports.models.serves(model),
        capabilities: (model) => this.#backendFor(model).ports.models.capabilities(model),
        metadata: (model) => this.#backendFor(model).ports.models.metadata(model),
        reasoning: (model) => this.#backendFor(model).ports.models.reasoning(model),
        reasoningWireShape: (model) => this.reasoningWireShape(model)
      },
      responses: {
        kind: "responses",
        supports: (model) => this.supportsResponses(model),
        execute: (body, signal, requestOptions) => this.responses(body, signal, requestOptions)
      },
      lifecycle: { kind: "owned", close: async () => await this.close() }
    };
  }

  #backendFor(model: string | undefined): Backend {
    return model !== undefined && this.#routedIds.has(model) ? this.#routed : this.#primary;
  }

  listModelIds(): readonly string[] {
    const ids = [...this.#primary.ports.models.list()];
    for (const id of this.#routedIds) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested !== undefined && this.#routedIds.has(requested)) return requested;
    return this.#primary.ports.models.resolve(requested);
  }

  reasoningWireShape(model: string): string | undefined {
    const backend = this.#backendFor(model);
    const delegatedModel =
      backend === this.#routed
        ? (backend.ports.models.resolve(model) ?? model)
        : (backend.ports.models.resolve(model) ?? backend.defaultModel ?? model);
    return backend.ports.models.reasoningWireShape(delegatedModel);
  }

  chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): BackendRequest {
    const model =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    return this.#backendFor(model).chat(body, signal, options);
  }

  supportsResponses(model: string): boolean {
    const backend = this.#backendFor(model);
    const delegatedModel = backend.ports.models.resolve(model) ?? backend.defaultModel ?? model;
    const responses = backend.ports.responses;
    return responses.kind === "responses" && responses.supports(delegatedModel);
  }

  responses(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): BackendRequest {
    const model =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    const backend = this.#backendFor(model);
    const responses = backend.ports.responses;
    if (responses.kind === "unsupported") {
      return Effect.succeed(
        Response.json(
          { error: { type: "not_supported", message: "native Responses egress is not supported" } },
          { status: 501 }
        )
      );
    }
    return responses.execute(body, signal, options);
  }

  models(signal?: AbortSignal): BackendRequest {
    return this.#primary.models(signal);
  }

  embeddings(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const model =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    return this.#backendFor(model).embeddings(body, signal, options);
  }

  async close(): Promise<void> {
    const primaryLifecycle = this.#primary.ports.lifecycle;
    const routedLifecycle = this.#routed.ports.lifecycle;
    if (primaryLifecycle.kind === "owned") await primaryLifecycle.close();
    if (routedLifecycle.kind === "owned") await routedLifecycle.close();
  }
}
