/**
 * The gateway's model backend. The default HTTP implementation speaks
 * OpenAI-compatible Chat Completions, but provider-native implementations can
 * adapt another wire protocol behind the same interface. The backend is a thin
 * `fetch` wrapper that returns the upstream `Response` unchanged, so the chat
 * surface can stream straight through and the dialect adapters can consume the
 * same core without a second abstraction.
 */
import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  RequestAttribution
} from "@velum-labs/routekit-contracts";
import {
  REASONING_SELECTION,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf,
  withoutRouteKitExtensions
} from "./adapters/openai-chat-wire.js";
import { normalizeOpenAiResponsesCallIds } from "./adapters/openai-responses-wire.js";

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
      execute(
        body: unknown,
        signal?: AbortSignal,
        options?: BackendRequestOptions
      ): Promise<Response>;
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

export type Backend = {
  /** Explicit capability and ownership ports. */
  ports: BackendPorts;
  /** Model id sent to the backend when a request omits one. */
  readonly defaultModel: string | undefined;
  /** POST <base>/chat/completions — supports streaming (SSE) upstream. */
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): Promise<Response>;
  /** GET <base>/models. */
  models(signal?: AbortSignal): Promise<Response>;
  /** POST <base>/embeddings. */
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
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
};

export type RequestAttributionUpdate = Partial<RequestAttribution> & {
  accountAttempt?: {
    operationId: string;
    seat: string;
  };
};

export type OpenAiBackendOptions = {
  /**
   * Base URL including the OpenAI API prefix, e.g.
   * `http://127.0.0.1:8080/v1`. Route paths (`/chat/completions`, `/models`,
   * `/embeddings`) are appended to this value.
   */
  baseUrl: string;
  /**
   * Bearer credential forwarded to the backend. Local servers ignore it; the
   * default mirrors the `not-needed` placeholder the AI SDK uses for local
   * OpenAI-compatible servers.
   */
  apiKey?: string;
  /** Model id used when a request omits `model`. */
  defaultModel?: string;
  /**
   * When set, every request's `model` is overwritten with this id before it is
   * forwarded upstream, regardless of what the client sent. Used by per-candidate
   * capture gateways that are dedicated to one routed endpoint: the driving CLI
   * (e.g. Claude Code) picks its own model label, but the router must always
   * receive the routed model id. Absent means the client's model passes through.
   */
  forceModel?: string;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
};

/** Join a base URL (which may end in `/`) with a route path. */
export function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function invalidReasoningControlResponse(
  message: string,
  metadata = false,
  path?: string
): Response {
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: metadata ? "invalid_reasoning_metadata" : "invalid_reasoning_control",
        ...(path !== undefined ? { param: path } : {}),
        message
      }
    },
    { status: 400 }
  );
}

/** An OpenAI HTTP backend supporting Chat Completions and native Responses. */
export class OpenAiBackend implements Backend {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #forceModel: string | undefined;
  readonly #extraHeaders: Record<string, string>;
  readonly defaultModel: string | undefined;
  readonly ports: BackendPorts;

  constructor(options: OpenAiBackendOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey ?? "not-needed";
    this.#forceModel = options.forceModel;
    this.#extraHeaders = options.headers ?? {};
    this.defaultModel = options.defaultModel;
    this.ports = {
      models: staticBackendModelPort(this.defaultModel),
      responses: {
        kind: "responses",
        supports: () => true,
        execute: async (body, signal, requestOptions) =>
          await this.responses(body, signal, requestOptions)
      },
      lifecycle: { kind: "borrowed" }
    };
  }

  #headers(options: BackendRequestOptions = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      ...this.#extraHeaders,
      ...(options.modelCallId ? { "x-routekit-model-call-id": options.modelCallId } : {})
    };
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const routed =
      this.#forceModel !== undefined &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: this.#forceModel }
        : body;
    const validationError = routeKitRequestValidationErrorOf(routed);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    const selection = reasoningSelectionOf(routed);
    if (
      (selection.mode === "budget" || selection.mode === "adaptive") &&
      options.reasoningCapabilities?.wireShape !== "openrouter"
    ) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: `OpenAI Chat cannot represent reasoning mode "${selection.mode}"`
            }
          },
          { status: 400 }
        )
      );
    }
    const canonicalSelection =
      routed !== null &&
      typeof routed === "object" &&
      !Array.isArray(routed) &&
      ((routed as Record<PropertyKey, unknown>)[REASONING_SELECTION] !== undefined ||
        (routed as { x_routekit?: { selection?: unknown } }).x_routekit?.selection !== undefined);
    const selectedPayload =
      canonicalSelection && routed !== null && typeof routed === "object" && !Array.isArray(routed)
        ? {
            ...(routed as Record<string, unknown>),
            ...(selection.mode === "effort" ? { reasoning_effort: selection.effort } : {})
          }
        : routed;
    if (
      canonicalSelection &&
      selection.mode !== "effort" &&
      selectedPayload !== null &&
      typeof selectedPayload === "object" &&
      !Array.isArray(selectedPayload)
    ) {
      delete (selectedPayload as Record<string, unknown>).reasoning_effort;
    }
    const payload =
      options.reasoningCapabilities?.wireShape === "openrouter" &&
      selectedPayload !== null &&
      typeof selectedPayload === "object" &&
      !Array.isArray(selectedPayload)
        ? this.#openRouterReasoning(selectedPayload as Record<string, unknown>, selection)
        : selectedPayload;
    const providerPayload = withoutRouteKitExtensions(payload);
    return fetch(joinPath(this.#baseUrl, "/chat/completions"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(providerPayload),
      ...(signal ? { signal } : {})
    });
  }

  supportsResponses(): boolean {
    return true;
  }

  responses(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const routed =
      this.#forceModel !== undefined &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: this.#forceModel }
        : body;
    const providerPayload = withoutRouteKitExtensions(routed);
    return fetch(joinPath(this.#baseUrl, "/responses"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(normalizeOpenAiResponsesCallIds(providerPayload)),
      ...(signal ? { signal } : {})
    });
  }

  #openRouterReasoning(
    body: Record<string, unknown>,
    selection: ReturnType<typeof reasoningSelectionOf>
  ): Record<string, unknown> {
    const payload = { ...body };
    delete payload.reasoning_effort;
    if (selection.mode === "effort") {
      payload.reasoning = { effort: selection.effort };
    } else if (selection.mode === "budget") {
      payload.reasoning = { max_tokens: selection.budgetTokens };
    } else if (selection.mode === "adaptive") {
      payload.reasoning = { enabled: true };
    } else if (selection.mode === "disabled") {
      payload.reasoning = { enabled: false };
    }
    return payload;
  }

  models(signal?: AbortSignal): Promise<Response> {
    return fetch(joinPath(this.#baseUrl, "/models"), {
      method: "GET",
      headers: this.#headers(),
      ...(signal ? { signal } : {})
    });
  }

  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    return fetch(joinPath(this.#baseUrl, "/embeddings"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
  }
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
        execute: async (body, signal, requestOptions) =>
          await this.responses(body, signal, requestOptions)
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

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
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
  ): Promise<Response> {
    const model =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    const backend = this.#backendFor(model);
    const responses = backend.ports.responses;
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

  models(signal?: AbortSignal): Promise<Response> {
    return this.#primary.models(signal);
  }

  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
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
