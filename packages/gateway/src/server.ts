import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type {
  ModelReasoningCapabilities,
  RequestAttribution
} from "@velum-labs/routekit-contracts";
import {
  codexCompatibility,
  ProviderFailureError,
  reasoningEffortDescriptors
} from "@velum-labs/routekit-contracts";
import { ResourceScope } from "@velum-labs/routekit-runtime";
import type { AnthropicRequest, ClaudeModelSelection } from "./adapters/anthropic.js";
import {
  anthropicModelsResponse,
  handleAnthropicMessages,
  handleCountTokens,
  resolveClaudeModelSelection,
  withClaudeReasoningSelection
} from "./adapters/anthropic.js";
import { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
import {
  cursorModelVariants,
  isCursorChatBody,
  resolveCursorModelSelection,
  translateCursorRequest
} from "./adapters/cursor.js";
import { droppedField } from "./adapters/dropped.js";
import {
  routeKitRequestValidationErrorOf,
  withReasoningSelection
} from "./adapters/openai-chat-wire.js";
import {
  prepareResponsesReasoningInput,
  wrapResponsesReasoningResponse
} from "./adapters/openai-responses-wire.js";
import type { ResponsesRequest } from "./adapters/responses.js";
import { handleResponses } from "./adapters/responses.js";
import type { WireRejection } from "./adapters/validate.js";
import {
  validateAnthropicRequest,
  validateChatRequest,
  validateCountTokensRequest,
  decodeValidatedAnthropicRequest,
  decodeValidatedResponsesRequest,
  validateResponsesRequest
} from "./adapters/validate.js";
import { authorizedRequest, parsePrincipalHeader, ROUTEKIT_PRINCIPAL_HEADER } from "./auth.js";
import {
  backendPorts,
  type Backend,
  type BackendModelRoute,
  type BackendRequestOptions
} from "./backend.js";
import { AnthropicMessagesEndpoint } from "./endpoints/anthropic-messages-endpoint.js";
import { ChatEndpoint } from "./endpoints/chat-endpoint.js";
import {
  EndpointAuthenticationError,
  type EndpointContext
} from "./endpoints/endpoint-module.js";
import { ModelsEndpoint } from "./endpoints/models-endpoint.js";
import { ResponsesEndpoint } from "./endpoints/responses-endpoint.js";
import { UsageEndpoint } from "./endpoints/usage-endpoint.js";
import { waitForDrainOrClose } from "./http-response.js";
import { StreamPump } from "./sse/stream-pump.js";
import type { GatewayDialect, ModelGatewayCallContext, ProvenanceSink } from "./provenance.js";
import { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId } from "./provenance.js";
import { NoModelAvailableError, UnknownModelError } from "./router.js";
import { decodeModelCatalogPayload } from "./provider-protocol.js";

/**
 * The local-model gateway HTTP server. It fronts a single OpenAI Chat
 * Completions backend (the owned mlx fork by default) and exposes the wire
 * dialects each agent harness needs: OpenAI chat, Anthropic Messages, OpenAI
 * Responses, and Cursor's Responses-hybrid BYOK shape.
 */

export type GatewayOptions = {
  backend: Backend;
  /** Bind host; defaults to loopback. */
  host?: string;
  /** Bind port; defaults to an ephemeral free port. */
  port?: number;
  /** When set, require this bearer token (or matching `x-api-key`). */
  authToken?: string;
  /** Optional observation sink for model calls. */
  provenance?: ProvenanceSink;
  /** Optional client-authenticated Responses relay. */
  codexRelay?: ProviderRelayPorts;
  /** Provider-native relays sharing this HTTP boundary. */
  providerRelays?: Partial<Record<ProviderRelayDialect, ProviderRelayPorts>>;
  /** Optional provider usage payload for `GET /usage`. */
  usage?: () => unknown | Promise<unknown>;
};

export type ProviderRelayDialect = "anthropic" | "codex";

export type RequestRelay = {
  readonly kind: "request";
  readonly dialect: ProviderRelayDialect;
  shouldRelay(
    headers: IncomingMessage["headers"],
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: IncomingMessage["headers"],
    body: AnthropicRequest | ResponsesRequest,
    signal?: AbortSignal,
    options?: Pick<BackendRequestOptions, "onAttribution" | "responseMode">
  ): Promise<Response>;
};

export type ModelCatalogRelay = {
  readonly kind: "models";
  readonly dialect: "anthropic";
  models(
    headers: IncomingMessage["headers"],
    search: string,
    signal?: AbortSignal
  ): Promise<Response>;
} | {
  readonly kind: "merged-models";
  readonly dialect: "codex";
  mergedCatalog(
    headers: IncomingMessage["headers"],
    search: string
  ): Promise<
    | {
        models: Array<Record<string, unknown>>;
        etag?: string;
      }
    | undefined
  >;
  mergeDataIds(
    data: Array<{ id: string } & Record<string, unknown>>,
    models: readonly Record<string, unknown>[]
  ): Array<{ id: string } & Record<string, unknown>>;
};

export type TokenCountRelay = {
  readonly kind: "token-count";
  readonly dialect: "anthropic";
  countTokens(
    headers: IncomingMessage["headers"],
    body: AnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response>;
};

export type RelayLifecycle = {
  readonly kind: "lifecycle";
  close(): Promise<void> | void;
};

export type ProviderRelayPorts = Readonly<{
  request: RequestRelay;
  catalog?: ModelCatalogRelay;
  tokenCount?: TokenCountRelay;
  lifecycle?: RelayLifecycle;
}>;

export type Gateway = {
  /** Base URL clients should target (without the `/v1` suffix). */
  url(): string;
  port(): number;
  /**
   * Graceful drain: flip `/health` to 503 and reject new model calls while
   * letting in-flight requests (long-lived LLM streams) finish, bounded by
   * `graceMs`; then close the listener and sever whatever remains. Does not
   * release the backend — follow with {@link close}.
   */
  drain(graceMs?: number): Promise<void>;
  /** Immediate close: equivalent to `drain(0)` plus backend/relay teardown. */
  close(): Promise<void>;
};

function codexModelInfo(
  id: string,
  priority: number,
  reasoning?: ModelReasoningCapabilities
): Record<string, unknown> {
  const levels = reasoningEffortDescriptors(reasoning).map((effort) => ({
    effort: effort.id,
    description: effort.label
  }));
  return {
    slug: id,
    prefer_websockets: false,
    display_name: id,
    description: "RouteKit live model",
    ...(reasoning?.defaultEffort !== undefined
      ? { default_reasoning_level: reasoning.defaultEffort }
      : {}),
    // Codex parses ModelInfo strictly; this field must exist on every entry,
    // and an empty list means "no discovered effort controls".
    supported_reasoning_levels: levels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are a coding agent.",
    model_messages: {
      instructions_template: "You are a coding agent.",
      instructions_variables: null
    },
    supports_reasoning_summaries:
      reasoning?.status === "supported" &&
      (reasoning.wireShape === "openai-responses" ||
        reasoning.wireShape === "anthropic" ||
        reasoning.wireShape === "openrouter"),
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272_000,
    max_context_window: 272_000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: false
  };
}

function catalogModelRoutes(backend: Backend): BackendModelRoute[] {
  if (backendPorts(backend).models.kind === "static-model") return [];
  return (backendPorts(backend).models.list() ?? []).flatMap((model) => {
    const route = backendPorts(backend).models.resolveRoute(model);
    return route === undefined ? [] : [route];
  });
}

function resolveClaudeSelection(
  backend: Backend,
  requested: string | undefined
): ClaudeModelSelection {
  return resolveClaudeModelSelection(
    requested,
    backendPorts(backend).models.list() ?? [],
    catalogModelRoutes(backend)
  );
}

function writeClaudeSelectionError(
  res: ServerResponse,
  selection: Extract<ClaudeModelSelection, { message: string }>
): void {
  writeJson(res, 400, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: selection.message
    }
  });
}

/**
 * Recent Claude Code versions send adaptive thinking and an effort on every
 * turn, including for picker entries that advertise no reasoning controls.
 * The picker is authoritative here: forwarding that implicit client default
 * would make the router reject an otherwise valid model before it reaches its
 * provider. Keep explicit RouteKit effort variants strict, but remove the
 * unrepresentable native default for a base, non-reasoning route.
 */
function withoutUnsupportedClaudeReasoning(body: AnthropicRequest): AnthropicRequest {
  const { thinking: _thinking, output_config: outputConfig, ...rest } = body;
  if (outputConfig === undefined || outputConfig === null) return rest;
  const { effort: _effort, ...remainingOutputConfig } = outputConfig;
  return Object.keys(remainingOutputConfig).length === 0
    ? rest
    : { ...rest, output_config: remainingOutputConfig };
}

function resolveNativeModelRoute(
  backend: Backend,
  provider: "claude-code" | "codex",
  requested: string | undefined
): BackendModelRoute | undefined {
  if (backendPorts(backend).models.kind === "static-model") return undefined;
  const route = backendPorts(backend).models.resolveRoute(requested, provider);
  if (route === undefined && requested !== undefined) {
    throw new UnknownModelError(requested);
  }
  return route;
}

export function initialAttribution(
  backend: Backend,
  requested: string | undefined,
  nativeProvider?: "claude-code" | "codex"
): Partial<RequestAttribution> {
  const route = backendPorts(backend).models.resolveRoute(requested, nativeProvider);
  const effectiveModel = route?.publicId ?? requested ?? backend.defaultModel;
  if (effectiveModel === undefined) return {};
  const slash = effectiveModel.indexOf("/");
  const provider =
    route?.provider ?? (slash > 0 ? effectiveModel.slice(0, slash) : (nativeProvider ?? "unknown"));
  const nativeModel =
    route?.nativeId ?? (slash > 0 ? effectiveModel.slice(slash + 1) : effectiveModel);
  return {
    effective_model: effectiveModel,
    native_model: nativeModel,
    provider,
    billing_mode:
      provider === "codex" || provider === "claude-code" || provider === "cliproxy"
        ? "subscription"
        : "api_key"
  };
}

function withModel<T extends Record<string, unknown>>(body: T, model: string): T {
  return { ...body, model };
}

/**
 * Codex keeps the session's initial model instructions when `/model` switches
 * to a different provider. A session started on a stock Codex model therefore
 * sends its "You are Codex ... based on GPT-5" identity even after selecting
 * Claude. The selected model's current instructions are already present in the
 * Responses input, so remove only this contradictory stale identity at the
 * cross-provider boundary. Native Codex routes remain byte-for-byte intact.
 */
function withoutStaleCodexIdentity(
  body: ResponsesRequest,
  route: BackendModelRoute | undefined
): ResponsesRequest {
  if (
    route?.provider === "codex" ||
    typeof body.instructions !== "string" ||
    !/^\s*You are Codex\b/i.test(body.instructions) ||
    !/\bbased on GPT-5\b/i.test(body.instructions)
  ) {
    return body;
  }
  const { instructions: _staleIdentity, ...rest } = body;
  return rest;
}

function codexPickerModels(
  backend: Backend,
  configured: Array<{ id: string } & Record<string, unknown>>,
  native: readonly Record<string, unknown>[],
  includeUnroutedNative: boolean
): Record<string, unknown>[] {
  const nativeBySlug = new Map(
    native.flatMap((entry) =>
      typeof entry.slug === "string" ? [[entry.slug, entry] as const] : []
    )
  );
  const seen = new Set<string>();
  const eligible = configured.filter((entry) => {
    if (backendPorts(backend).models.kind === "static-model") return true;
    const route = backendPorts(backend).models.resolveRoute(entry.id);
    if (route === undefined) return true;
    const tools = backendPorts(backend).models.capabilities(entry.id).tools;
    return (
      codexCompatibility({
        id: entry.id,
        ...(route?.provider !== undefined ? { provider: route.provider } : {}),
        ...(route?.metadata?.architecture !== undefined
          ? { architecture: route.metadata.architecture }
          : {}),
        ...(route?.metadata?.supportedParameters !== undefined
          ? { supportedParameters: route.metadata.supportedParameters }
          : {}),
        ...(tools === "supported" ||
        tools === "degraded" ||
        tools === "unsupported" ||
        tools === "unknown"
          ? { capabilities: { tools } }
          : {}),
        ...(route?.reasoning !== undefined ? { reasoning: route.reasoning } : {})
      }).status === "compatible"
    );
  });
  const models = eligible.map((entry, priority) => {
    const route = backendPorts(backend).models.resolveRoute(entry.id);
    const slug = route?.provider === "codex" ? route.nativeId : entry.id;
    seen.add(slug);
    const upstream = nativeBySlug.get(slug);
    return upstream === undefined
      ? codexModelInfo(slug, priority, route?.reasoning)
      : { ...upstream, slug, priority };
  });
  if (!includeUnroutedNative) return models;
  for (const entry of native) {
    const slug = typeof entry.slug === "string" ? entry.slug : undefined;
    if (slug === undefined || seen.has(slug)) continue;
    seen.add(slug);
    models.push(entry);
  }
  return models;
}

async function mergeAnthropicCatalogs(configured: Response, native: Response): Promise<Response> {
  if (!native.ok) return configured;
  const configuredBody = decodeModelCatalogPayload(
    await configured.json(),
    "routekit-anthropic"
  );
  const nativeBody = decodeModelCatalogPayload(
    await native.json(),
    "anthropic"
  );
  const data = [...configuredBody.data];
  const seen = new Set(data.map((entry) => entry.id));
  for (const entry of nativeBody.data) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    data.push(entry);
  }
  return Response.json(
    {
      ...nativeBody,
      data,
      has_more: false,
      first_id: typeof data[0]?.id === "string" ? data[0].id : undefined,
      last_id: typeof data.at(-1)?.id === "string" ? data.at(-1)?.id : undefined
    },
    { headers: native.headers }
  );
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const host = options.host ?? "127.0.0.1";
  const { backend, authToken, provenance } = options;
  // Client-forwarded Codex auth and server-owned subscription accounts are
  // distinct trust models. Gateway auth disables only the client-forwarded
  // relay; a server-owned account set remains available behind the proxy key.
  const codexClientPorts = authToken === undefined ? options.codexRelay : undefined;
  const anthropicPorts = options.providerRelays?.anthropic;
  const codexProviderPorts = options.providerRelays?.codex;
  const codexClientRelay = codexClientPorts?.request;
  const anthropicRelay = anthropicPorts?.request;
  const anthropicCatalogRelay = anthropicPorts?.catalog;
  const anthropicTokenCountRelay = anthropicPorts?.tokenCount;
  const codexProviderRequest = codexProviderPorts?.request;
  const codexClientCatalog =
    codexClientPorts?.catalog?.kind === "merged-models" ? codexClientPorts.catalog : undefined;
  const codexProviderCatalog =
    codexProviderPorts?.catalog?.kind === "merged-models"
      ? codexProviderPorts.catalog
      : undefined;
  const codexCatalogRelay =
    codexProviderCatalog ?? codexClientCatalog;
  const codexRequestRelay = codexProviderRequest ?? codexClientRelay;
  const endpointAuthenticate = (context: EndpointContext): void => {
    if (authToken !== undefined && !authorizedRequest(context.request, authToken)) {
      throw new EndpointAuthenticationError();
    }
  };
  const usageEndpoint = new UsageEndpoint(endpointAuthenticate, options.usage, writeJson);
  const modelsEndpoint = new ModelsEndpoint(endpointAuthenticate, {
    backend,
    anthropicRelayAvailable: anthropicRelay !== undefined,
    ...(anthropicCatalogRelay?.kind === "models" &&
    backendPorts(backend).models.kind === "static-model"
      ? {
          anthropicCatalog: async ({ request, url }, configured) =>
            await mergeAnthropicCatalogs(
              configured,
              await anthropicCatalogRelay.models(request.headers, url.search)
            )
        }
      : {}),
    ...(codexCatalogRelay !== undefined ? { codexCatalog: codexCatalogRelay } : {}),
    includeCodexNativeModels: codexProviderRequest === undefined,
    configuredAnthropicCatalog: () =>
      anthropicModelsResponse(
        backend.defaultModel,
        backendPorts(backend).models.list(),
        catalogModelRoutes(backend)
      ),
    pickerModels: (configured, native, includeUnroutedNative) =>
      codexPickerModels(backend, configured, native, includeUnroutedNative),
    resolveRetrieval: (id) => {
      const selection = resolveClaudeSelection(backend, id);
      if (selection.status === "unsupported_effort" || selection.status === "ambiguous_model") {
        return { status: "invalid", message: selection.message };
      }
      const alias = selection.model;
      const route = backendPorts(backend).models.resolveRoute(alias, "claude-code");
      const resolved = route?.publicId ?? alias;
      return resolved.length === 0 ||
        (backendPorts(backend).models.kind === "model-catalog" && route === undefined) ||
        (backendPorts(backend).models.kind === "static-model" &&
          !backendPorts(backend).models.serves(resolved) &&
          anthropicRelay === undefined)
        ? { status: "missing" }
        : { status: "ok", displayName: route?.nativeId ?? resolved };
    },
    writeJson,
    pipe: async (response, upstream) => {
      await pipeUpstream(response, upstream);
    }
  });
  const chatEndpoint = new ChatEndpoint(endpointAuthenticate, {
    backend,
    readBody: async ({ request, response }) => {
      const body = await readJson(request, response);
      return body === NO_BODY ? undefined : body;
    },
    writeJson,
    rejectInvalid,
    dispatch: async ({ request, response }, call) =>
      await modelCallDispatcher(request, response)(call),
    attribution: (requested) => initialAttribution(backend, requested)
  });
  const endpointBodyReader = async ({
    request,
    response
  }: EndpointContext): Promise<unknown | undefined> => {
    const body = await readJson(request, response);
    return body === NO_BODY ? undefined : body;
  };
  const endpointDispatch = async (
    { request, response }: EndpointContext,
    call: ModelCallRoute
  ): Promise<void> => await modelCallDispatcher(request, response)(call);
  const anthropicEndpoint = new AnthropicMessagesEndpoint(endpointAuthenticate, {
    backend,
    ...(anthropicRelay !== undefined ? { requestRelay: anthropicRelay } : {}),
    ...(anthropicTokenCountRelay !== undefined
      ? { tokenCountRelay: anthropicTokenCountRelay }
      : {}),
    readBody: endpointBodyReader,
    writeJson,
    rejectInvalid,
    pipe: async (response, upstream) => {
      await pipeUpstream(response, upstream);
    },
    dispatch: endpointDispatch,
    attribution: (requested, nativeProvider) =>
      initialAttribution(backend, requested, nativeProvider)
  });
  const responsesEndpoint = new ResponsesEndpoint(endpointAuthenticate, {
    backend,
    ...(codexProviderRequest !== undefined ? { providerRelay: codexProviderRequest } : {}),
    ...(codexRequestRelay !== undefined ? { clientRelay: codexRequestRelay } : {}),
    readBody: endpointBodyReader,
    rejectInvalid,
    dispatch: endpointDispatch,
    attribution: (requested, nativeProvider) =>
      initialAttribution(backend, requested, nativeProvider)
  });

  function modelCallDispatcher(
    req: IncomingMessage,
    res: ServerResponse
  ): (route: ModelCallRoute) => Promise<void> {
    const headerPrincipal = parsePrincipalHeader(
      typeof req.headers[ROUTEKIT_PRINCIPAL_HEADER] === "string"
        ? req.headers[ROUTEKIT_PRINCIPAL_HEADER]
        : undefined
    );
    const principal =
      headerPrincipal === undefined
        ? undefined
        : { token_id: headerPrincipal.id, label: headerPrincipal.label };
    return async (route) =>
      await handleModelCall(res, provenance, {
        ...route,
        ...(principal !== undefined ? { principal } : {})
      });
  }

  // In-flight request count drives the drain loop: a drain completes as soon
  // as every accepted request has finished (or its grace expires).
  let inflight = 0;
  let draining = false;
  const server = createServer((req, res) => {
    inflight += 1;
    res.once("close", () => {
      inflight -= 1;
    });
    void handle(req, res).catch((error: unknown) => {
      // This catch must never throw: a throw here becomes an unhandled
      // rejection that kills the process hosting the gateway.
      writeGatewayError(res, error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/health") {
      // A draining gateway reports unhealthy so pollers (readiness probes,
      // upgrade orchestration) route new work elsewhere.
      if (draining) writeJson(res, 503, { status: "draining" });
      else writeJson(res, 200, { status: "ok" });
      return;
    }

    if (draining) {
      writeJson(res, 503, {
        error: { message: "gateway is draining", type: "unavailable" }
      });
      return;
    }

    const endpointContext: EndpointContext = { request: req, response: res, method, url };
    const endpoints = [
      usageEndpoint,
      modelsEndpoint,
      chatEndpoint,
      anthropicEndpoint,
      responsesEndpoint
    ] as const;
    for (const endpoint of endpoints) {
      if (!endpoint.matches(method, path)) continue;
      await endpoint.handle(endpointContext);
      return;
    }

    writeJson(res, 404, {
      error: { message: `no route for ${method} ${path}`, type: "not_found" }
    });
  }


  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);

  let drainRun: Promise<void> | undefined;
  const drain = (graceMs = 0): Promise<void> => {
    drainRun ??= (async () => {
      draining = true;
      // Reap idle keep-alive sockets now; active streams keep their sockets
      // until they finish or the grace expires.
      server.closeIdleConnections();
      const deadline = Date.now() + graceMs;
      while (inflight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeAllConnections();
      await closed;
    })();
    return drainRun;
  };
  const resources = new ResourceScope();
  const lifecycles = new Set(
    [codexClientPorts?.lifecycle, anthropicPorts?.lifecycle, codexProviderPorts?.lifecycle].filter(
      (lifecycle): lifecycle is RelayLifecycle => lifecycle !== undefined
    )
  );
  for (const lifecycle of lifecycles) {
    resources.defer(async () => await lifecycle.close());
  }
  const backendLifecycle = backendPorts(backend).lifecycle;
  if (backendLifecycle.kind === "owned") {
    resources.defer(async () => await backendLifecycle.close());
  }
  resources.defer(async () => await drain(0));

  return {
    url: () => `http://${host}:${port}`,
    port: () => port,
    drain,
    close: async () => await resources.dispose()
  };
}

// ---- HTTP helpers (Node built-ins only) ----

const NO_BODY = Symbol("no-body");
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const value of req) {
    const chunk = value as Buffer;
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new RequestBodyTooLargeError();
  return Buffer.concat(chunks);
}

class RequestBodyTooLargeError extends Error {}

/**
 * Read and parse a JSON request body. On malformed JSON, write a 400 and
 * return the NO_BODY sentinel so the caller stops processing.
 */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    req.resume();
    writeJson(res, 413, {
      error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
    });
    return NO_BODY;
  }
  let buffer: Buffer;
  try {
    buffer = await readBody(req);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLargeError)) throw error;
    writeJson(res, 413, {
      error: { message: "request body exceeds the 16 MiB limit", type: "payload_too_large" }
    });
    return NO_BODY;
  }
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    writeJson(res, 400, { error: { message: "invalid JSON body", type: "bad_request" } });
    return NO_BODY;
  }
}

/** Write a structural-validation rejection (if any) and report whether one was written. */
function rejectInvalid(res: ServerResponse, rejection: WireRejection | undefined): boolean {
  if (rejection === undefined) return false;
  writeJson(res, rejection.status, rejection.body);
  return true;
}

function writeJson(res: ServerResponse, status: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.byteLength));
  res.end(payload);
  return payload;
}

/**
 * Report an error on a response that may already be mid-stream. Once headers
 * are sent (e.g. an SSE turn whose upstream died — a crashed local model
 * server), `writeJson` would throw ERR_HTTP_HEADERS_SENT, so instead destroy
 * the socket: the client sees a clean disconnect for that one request while
 * the gateway process stays alive. Never throws.
 */
function writeErrorSafely(res: ServerResponse, status: number, value: unknown): Buffer {
  try {
    if (!res.headersSent) return writeJson(res, status, value);
    if (!res.writableEnded) res.destroy();
  } catch {
    // last resort: nothing we can do with this response, but the server lives
  }
  return Buffer.alloc(0);
}

/**
 * Map a normalized provider failure to HTTP, preserving retry timing.
 */
function writeGatewayError(
  res: ServerResponse,
  error: unknown
): { statusCode: number; payload: Buffer } {
  if (error instanceof EndpointAuthenticationError) {
    const payload = writeErrorSafely(res, 401, {
      error: { message: "unauthorized", type: "auth_error" }
    });
    return { statusCode: 401, payload };
  }
  if (error instanceof NoModelAvailableError) {
    const payload = writeErrorSafely(res, 503, {
      error: {
        message: error.message,
        type: "unavailable"
      }
    });
    return { statusCode: 503, payload };
  }
  if (error instanceof UnknownModelError) {
    const payload = writeErrorSafely(res, 400, {
      error: {
        message: error.message,
        type: "invalid_request_error",
        param: "model"
      }
    });
    return { statusCode: 400, payload };
  }
  if (error instanceof ProviderFailureError) {
    const { failure } = error;
    const retryAfter =
      failure.retryAfter ??
      (failure.resetsAt === undefined
        ? undefined
        : Math.max(0, failure.resetsAt - Date.now() / 1000));
    if (retryAfter !== undefined && !res.headersSent) {
      res.setHeader("retry-after", Math.max(0, Math.ceil(retryAfter)));
    }
    let status: number;
    let type: string;
    switch (failure.category) {
      case "quota_exhausted":
        status = 429;
        type = "rate_limit_error";
        break;
      case "auth_permanent":
        status = 502;
        type = "provider_auth_error";
        break;
      case "auth_transient":
        status = 503;
        type = "provider_auth_recovery_error";
        break;
      case "transient":
        status = 503;
        type = "upstream_error";
        break;
      case "context_overflow":
        status = 400;
        type = "context_length_exceeded";
        break;
      case "unknown":
        status = 502;
        type = "upstream_error";
        break;
      default: {
        const unreachable: never = failure.category;
        throw new Error(`unhandled provider failure category: ${String(unreachable)}`);
      }
    }
    const payload = writeErrorSafely(res, status, {
      error: {
        message: failure.message,
        type,
        ...(failure.resetsAt !== undefined ? { resets_at: failure.resetsAt } : {})
      }
    });
    return { statusCode: status, payload };
  }
  process.stderr.write(`routekit gateway upstream error: type=${safeErrorType(error)}\n`);
  const payload = writeErrorSafely(res, 502, {
    error: { message: "upstream request failed", type: "upstream_error" }
  });
  return { statusCode: 502, payload };
}

type ModelCallRoute = {
  dialect: GatewayDialect;
  body: unknown;
  defaultModel: string | undefined;
  attribution?: Partial<RequestAttribution>;
  /** Trusted data-plane principal from the switching proxy. */
  principal?: NonNullable<RequestAttribution["principal"]>;
  invoke: (
    callId: string,
    signal: AbortSignal,
    onAttribution: NonNullable<BackendRequestOptions["onAttribution"]>
  ) => Promise<Response>;
};

export function collectAttribution(seed: Partial<RequestAttribution> | undefined): {
  report: NonNullable<BackendRequestOptions["onAttribution"]>;
  snapshot(): RequestAttribution | undefined;
} {
  let current = { ...seed };
  let attempts = 0;
  let retries = 0;
  let accountFailovers = 0;
  const operations = new Map<string, { attempts: number; lastSeat?: string }>();
  return {
    report: (update) => {
      if (update.accountAttempt !== undefined) {
        const attempt = update.accountAttempt;
        const operation = operations.get(attempt.operationId) ?? { attempts: 0 };
        attempts += 1;
        if (operation.attempts > 0) retries += 1;
        if (operation.lastSeat !== undefined && operation.lastSeat !== attempt.seat) {
          accountFailovers += 1;
        }
        operations.set(attempt.operationId, {
          attempts: operation.attempts + 1,
          lastSeat: attempt.seat
        });
        current = { ...current, account: { seat: attempt.seat } };
      }
      const { accountAttempt: _accountAttempt, ...attribution } = update;
      current = { ...current, ...attribution };
    },
    snapshot: () => {
      if (
        current.effective_model === undefined ||
        current.provider === undefined ||
        current.billing_mode === undefined
      ) {
        return undefined;
      }
      return {
        effective_model: current.effective_model,
        ...(current.native_model !== undefined ? { native_model: current.native_model } : {}),
        provider: current.provider,
        billing_mode: current.billing_mode,
        ...(current.account !== undefined ? { account: current.account } : {}),
        ...(current.principal !== undefined ? { principal: current.principal } : {}),
        attempts: Math.max(1, attempts),
        retries,
        account_failovers: accountFailovers
      };
    }
  };
}

async function handleModelCall(
  res: ServerResponse,
  sink: ProvenanceSink | undefined,
  route: ModelCallRoute
): Promise<void> {
  const callId = modelCallId();
  const attribution = collectAttribution({
    ...route.attribution,
    ...(route.principal !== undefined ? { principal: route.principal } : {})
  });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const context: ModelGatewayCallContext = {
    callId,
    dialect: route.dialect,
    requestedModel: effectiveModel(route.body, route.defaultModel),
    model: effectiveModel(route.body, route.defaultModel),
    stream: isStream(route.body),
    requestBody: route.body,
    startedAt,
    endpointId: effectiveModel(route.body, route.defaultModel) ?? route.dialect
  };
  res.setHeader(MODEL_CALL_ID_HEADER, callId);
  // Cancel upstream work if the client hangs up before we finish responding.
  const aborter = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) aborter.abort();
  };
  res.once("close", onClose);
  try {
    const upstream = await route.invoke(callId, aborter.signal, attribution.report);
    // Only buffer the response body when a provenance sink will consume it.
    const body = await pipeUpstream(res, upstream, sink !== undefined, aborter.signal);
    const result = {
      statusCode: upstream.status,
      responseBody: body,
      durationMs: Date.now() - started
    };
    context.attribution = attribution.snapshot();
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } catch (error) {
    const { statusCode, payload } = writeGatewayError(res, error);
    const result = {
      statusCode,
      responseBody: payload,
      durationMs: Date.now() - started,
      error
    };
    context.attribution = attribution.snapshot();
    sink?.onModelCall?.(buildModelCallRecord(context, result));
    sink?.onModelCallRaw?.(context, result);
  } finally {
    res.off("close", onClose);
  }
}

/**
 * Cap on the body we buffer for provenance. A streamed turn is piped to the
 * client regardless; this only bounds the in-memory copy kept for the
 * provenance sink (request/response hashing + usage extraction), so a runaway
 * upstream cannot grow gateway memory without bound. 2 MiB comfortably covers a
 * routed chat completion (JSON or SSE); past it, provenance sees a truncated body.
 */
const PROVENANCE_BODY_CAP_BYTES = 2 * 1024 * 1024;

async function pipeUpstream(
  res: ServerResponse,
  upstream: Response,
  collectBody = false,
  signal?: AbortSignal
): Promise<Buffer> {
  res.statusCode = upstream.status;
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) res.setHeader("content-type", contentType);
  const body = upstream.body;
  if (body === null) {
    res.end();
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  try {
    await StreamPump.bytes(body, {
      ...(signal !== undefined ? { signal } : {}),
      async onChunk(value) {
        if (signal?.aborted === true || res.destroyed || res.writableEnded) {
          return;
        }
        const chunk = Buffer.from(value);
        // Accumulate for provenance only when a sink wants it, and only up to
        // the cap; the client always receives the full stream via res.write.
        if (collectBody && collectedBytes < PROVENANCE_BODY_CAP_BYTES) {
          chunks.push(chunk);
          collectedBytes += chunk.length;
        }
        if (!res.write(chunk)) {
          await waitForDrainOrClose(res);
        }
      }
    });
  } catch (error) {
    // The upstream stream died mid-response (e.g. a local model server was
    // OOM-killed). Destroy instead of end so the client sees an abnormal
    // disconnect for this request rather than a silently truncated body.
    res.destroy();
    throw error;
  }
  if (!res.destroyed && !res.writableEnded) res.end();
  return Buffer.concat(chunks);
}

function safeErrorType(error: unknown): string {
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof Error) return "Error";
  return "NonError";
}
