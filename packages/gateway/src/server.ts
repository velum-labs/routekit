import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { ResourceScope } from "@velum-labs/routekit-runtime";
import type { AnthropicRequest } from "./adapters/anthropic-wire.js";
import type { ResponsesRequest } from "./adapters/responses-wire.js";
import { authorizedHeaders, parsePrincipalHeader, ROUTEKIT_PRINCIPAL_HEADER } from "./auth.js";
import { type Backend, type BackendRequestOptions } from "./backend.js";
import { AnthropicMessagesEndpoint } from "./endpoints/anthropic-messages-endpoint.js";
import { ChatEndpoint } from "./endpoints/chat-endpoint.js";
import { EndpointAuthenticationError, type EndpointContext } from "./endpoints/endpoint-module.js";
import { ModelsEndpoint } from "./endpoints/models-endpoint.js";
import { ResponsesEndpoint } from "./endpoints/responses-endpoint.js";
import { UsageEndpoint } from "./endpoints/usage-endpoint.js";
import { NO_BODY, readJson } from "./http-request.js";
import { writeGatewayError } from "./gateway-errors.js";
import { writeJson } from "./http-response.js";
import type { ProvenanceSink } from "./provenance.js";
import {
  catalogModelRoutes,
  codexPickerModels,
  configuredAnthropicCatalog,
  initialAttribution,
  mergeAnthropicCatalogs,
  resolveClaudeSelection
} from "./catalog-service.js";
import {
  collectAttribution,
  handleModelCall,
  pipeUpstream,
  type ModelCallRoute
} from "./model-call-service.js";

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

export type ModelCatalogRelay =
  | {
      readonly kind: "models";
      readonly dialect: "anthropic";
      models(
        headers: IncomingMessage["headers"],
        search: string,
        signal?: AbortSignal
      ): Promise<Response>;
    }
  | {
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
    codexProviderPorts?.catalog?.kind === "merged-models" ? codexProviderPorts.catalog : undefined;
  const codexCatalogRelay = codexProviderCatalog ?? codexClientCatalog;
  const codexRequestRelay = codexProviderRequest ?? codexClientRelay;
  const endpointAuthenticate = (context: EndpointContext): void => {
    if (authToken !== undefined && !authorizedHeaders(context.headers, authToken)) {
      throw new EndpointAuthenticationError();
    }
  };
  const usageEndpoint = new UsageEndpoint(endpointAuthenticate, options.usage);
  const modelsEndpoint = new ModelsEndpoint(endpointAuthenticate, {
    backend,
    anthropicRelayAvailable: anthropicRelay !== undefined,
    ...(anthropicCatalogRelay?.kind === "models" && backend.ports.models.kind === "static-model"
      ? {
          anthropicCatalog: async ({ headers, url }, configured) =>
            await mergeAnthropicCatalogs(
              configured,
              await anthropicCatalogRelay.models(headers, url.search)
            )
        }
      : {}),
    ...(codexCatalogRelay !== undefined ? { codexCatalog: codexCatalogRelay } : {}),
    includeCodexNativeModels: codexProviderRequest === undefined,
    configuredAnthropicCatalog: () =>
      configuredAnthropicCatalog(backend),
    pickerModels: (configured, native, includeUnroutedNative) =>
      codexPickerModels(backend, configured, native, includeUnroutedNative),
    resolveRetrieval: (id) => {
      const selection = resolveClaudeSelection(backend, id);
      if (selection.status === "unsupported_effort" || selection.status === "ambiguous_model") {
        return { status: "invalid", message: selection.message };
      }
      const alias = selection.model;
      const route = backend.ports.models.resolveRoute(alias, "claude-code");
      const resolved = route?.publicId ?? alias;
      return resolved.length === 0 ||
        (backend.ports.models.kind === "model-catalog" && route === undefined) ||
        (backend.ports.models.kind === "static-model" &&
          !backend.ports.models.serves(resolved) &&
          anthropicRelay === undefined)
        ? { status: "missing" }
        : { status: "ok", displayName: route?.nativeId ?? resolved };
    }
  });
  const chatEndpoint = new ChatEndpoint(endpointAuthenticate, {
    backend,
    rejectInvalid: ({ transport }, rejection) => {
      if (rejection === undefined) return false;
      transport.writeJson(rejection.status, rejection.body);
      return true;
    },
    attribution: (requested) => initialAttribution(backend, requested)
  });
  const anthropicEndpoint = new AnthropicMessagesEndpoint(endpointAuthenticate, {
    backend,
    ...(anthropicRelay !== undefined ? { requestRelay: anthropicRelay } : {}),
    ...(anthropicTokenCountRelay !== undefined
      ? { tokenCountRelay: anthropicTokenCountRelay }
      : {}),
    rejectInvalid: ({ transport }, rejection) => {
      if (rejection === undefined) return false;
      transport.writeJson(rejection.status, rejection.body);
      return true;
    },
    attribution: (requested, nativeProvider) =>
      initialAttribution(backend, requested, nativeProvider)
  });
  const responsesEndpoint = new ResponsesEndpoint(endpointAuthenticate, {
    backend,
    ...(codexProviderRequest !== undefined ? { providerRelay: codexProviderRequest } : {}),
    ...(codexRequestRelay !== undefined ? { clientRelay: codexRequestRelay } : {}),
    rejectInvalid: ({ transport }, rejection) => {
      if (rejection === undefined) return false;
      transport.writeJson(rejection.status, rejection.body);
      return true;
    },
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

    const endpointContext: EndpointContext = {
      method,
      url,
      headers: req.headers,
      transport: {
        readJson: async () => {
          const body = await readJson(req, res);
          return body === NO_BODY ? undefined : body;
        },
        writeJson: (status, value) => {
          writeJson(res, status, value);
        },
        setHeader: (name, value) => res.setHeader(name, value),
        pipe: async (upstream) => {
          await pipeUpstream(res, upstream);
        },
        dispatch: async (call) => await modelCallDispatcher(req, res)(call)
      }
    };
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
  const backendLifecycle = backend.ports.lifecycle;
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
