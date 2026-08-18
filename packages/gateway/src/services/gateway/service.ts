import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import {
  createNodeHttpHandlerEffect,
  EffectResourceScope,
  type RouteKitPlatform,
  runRouteKitEffect
} from "@velum-labs/routekit-runtime/effect";
import { Deferred, Effect } from "effect";
import type { AnthropicRequest } from "../../adapters/anthropic-wire.js";
import type { ResponsesRequest } from "../../adapters/responses-wire.js";
import { authorizedHeaders } from "../../http/auth.js";
import {
  type Backend,
  type BackendRequest,
  type BackendRequestOptions
} from "../../providers/backend.js";
import {
  codexPickerModels,
  configuredAnthropicCatalog,
  initialAttribution,
  mergeAnthropicCatalogs,
  resolveClaudeSelection
} from "../catalog/service.js";
import { gatewayTryPromise } from "../../effect/gateway.js";
import { AnthropicMessagesEndpoint } from "../../endpoints/anthropic-messages-endpoint.js";
import { ChatEndpoint } from "../../endpoints/chat-endpoint.js";
import {
  EndpointAuthenticationError,
  type EndpointContext
} from "../../endpoints/endpoint-module.js";
import { ModelsEndpoint } from "../../endpoints/models-endpoint.js";
import { ResponsesEndpoint } from "../../endpoints/responses-endpoint.js";
import { UsageEndpoint } from "../../endpoints/usage-endpoint.js";
import type { CompositionalRoutingRuntime } from "../../routing/eval-policy.js";
import { buildGatewayHttpEffect } from "../../http/app.js";
import type { ProvenanceSink } from "../../observability/provenance.js";

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
  /** Dimension-decomposition and evidence-matrix runtime used by `model: "auto"`. */
  compositionalRouting?: CompositionalRoutingRuntime;
  /** Optional client-authenticated Responses relay. */
  codexRelay?: ProviderRelayPorts;
  /** Provider-native relays sharing this HTTP boundary. */
  providerRelays?: Partial<Record<ProviderRelayDialect, ProviderRelayPorts>>;
  /** Optional provider usage payload for `GET /usage`. */
  usage?: () => Effect.Effect<unknown, Error, RouteKitPlatform>;
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
  ): BackendRequest;
};

export type ModelCatalogRelay =
  | {
      readonly kind: "models";
      readonly dialect: "anthropic";
      models(
        headers: IncomingMessage["headers"],
        search: string,
        signal?: AbortSignal
      ): BackendRequest;
    }
  | {
      readonly kind: "merged-models";
      readonly dialect: "codex";
      mergedCatalog(
        headers: IncomingMessage["headers"],
        search: string
      ): Effect.Effect<
        | {
            models: Array<Record<string, unknown>>;
            etag?: string;
          }
        | undefined,
        Error,
        RouteKitPlatform
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
  ): BackendRequest;
};

export type RelayLifecycle = {
  readonly kind: "lifecycle";
  readonly close: Effect.Effect<void, Error, RouteKitPlatform>;
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
  drain(graceMs?: number): Effect.Effect<void, Error>;
  /** Immediate close: equivalent to `drain(0)` plus backend/relay teardown. */
  readonly close: Effect.Effect<void, unknown>;
};

function endpointAuthenticator(authToken: string | undefined) {
  return (context: EndpointContext): void => {
    if (authToken !== undefined && !authorizedHeaders(context.headers, authToken)) {
      throw new EndpointAuthenticationError();
    }
  };
}

const startGatewayOperation = Effect.fn("Gateway.start")(function* (
  options: GatewayOptions
): Effect.fn.Return<Gateway, Error, RouteKitPlatform> {
  const platform = yield* Effect.context<RouteKitPlatform>();
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
  const endpointAuthenticate = endpointAuthenticator(authToken);
  const usageEndpoint = new UsageEndpoint(endpointAuthenticate, options.usage);
  const modelsEndpoint = new ModelsEndpoint(endpointAuthenticate, {
    backend,
    anthropicRelayAvailable: anthropicRelay !== undefined,
    ...(anthropicCatalogRelay?.kind === "models" && backend.ports.models.kind === "static-model"
      ? {
          anthropicCatalog: ({ headers, url }, configured) =>
            Effect.gen(function* () {
              const native = yield* anthropicCatalogRelay.models(headers, url.search);
              return yield* mergeAnthropicCatalogs(configured, native);
            })
        }
      : {}),
    ...(codexCatalogRelay !== undefined ? { codexCatalog: codexCatalogRelay } : {}),
    includeCodexNativeModels: codexProviderRequest === undefined,
    configuredAnthropicCatalog: () => configuredAnthropicCatalog(backend),
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
    ...(options.compositionalRouting !== undefined
      ? { compositionalRouting: options.compositionalRouting }
      : {}),
    rejectInvalid: ({ transport }, rejection) => {
      if (rejection === undefined) return false;
      transport.writeJson(rejection.status, rejection.body);
      return true;
    },
    attribution: (requested) => initialAttribution(backend, requested)
  });
  const anthropicEndpoint = new AnthropicMessagesEndpoint(endpointAuthenticate, {
    backend,
    ...(options.compositionalRouting !== undefined
      ? { compositionalRouting: options.compositionalRouting }
      : {}),
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
    ...(options.compositionalRouting !== undefined
      ? { compositionalRouting: options.compositionalRouting }
      : {}),
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

  const endpoints = [
    usageEndpoint,
    modelsEndpoint,
    chatEndpoint,
    anthropicEndpoint,
    responsesEndpoint
  ] as const;

  // In-flight request count drives the drain loop: a drain completes as soon
  // as every accepted request has finished (or its grace expires).
  let inflight = 0;
  let draining = false;
  const httpEffect = yield* buildGatewayHttpEffect({
    draining: () => draining,
    endpoints,
    provenance
  });
  const nodeHandler = yield* createNodeHttpHandlerEffect(httpEffect);
  const server = createServer((req, res) => {
    inflight += 1;
    res.once("close", () => {
      inflight -= 1;
    });
    nodeHandler.handle(req, res);
  });

  yield* gatewayTryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(options.port ?? 0, host, () => {
          server.off("error", onError);
          resolve();
        });
      })
  );

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);

  const drainDone = Deferred.makeUnsafe<void, Error>();
  let drainStarted = false;
  const drain = (graceMs = 0): Effect.Effect<void, Error> =>
    Effect.suspend(() => {
      if (drainStarted) return Deferred.await(drainDone);
      drainStarted = true;
      const program = Effect.gen(function* () {
        draining = true;
        // Reap idle keep-alive sockets now; active streams keep their sockets
        // until they finish or the grace expires.
        server.closeIdleConnections();
        const deadline = Date.now() + graceMs;
        while (inflight > 0 && Date.now() < deadline) {
          yield* Effect.sleep("50 millis");
        }
        const closed = gatewayTryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error === undefined ? resolve() : reject(error)));
            })
        );
        server.closeAllConnections();
        yield* closed;
      });
      return Deferred.complete(drainDone, program).pipe(Effect.andThen(Deferred.await(drainDone)));
    });
  const resources = new EffectResourceScope();
  const lifecycles = new Set(
    [codexClientPorts?.lifecycle, anthropicPorts?.lifecycle, codexProviderPorts?.lifecycle].filter(
      (lifecycle): lifecycle is RelayLifecycle => lifecycle !== undefined
    )
  );
  for (const lifecycle of lifecycles) {
    yield* resources.deferEffect(lifecycle.close);
  }
  const backendLifecycle = backend.ports.lifecycle;
  if (backendLifecycle.kind === "owned") {
    yield* resources.deferEffect(backendLifecycle.close);
  }
  yield* resources.deferEffect(nodeHandler.close);
  yield* resources.deferEffect(drain(0));

  return {
    url: () => `http://${host}:${port}`,
    port: () => port,
    drain,
    close: resources.dispose().pipe(Effect.provide(platform))
  };
});

export function startGatewayEffect(
  options: GatewayOptions
): Effect.Effect<Gateway, Error, RouteKitPlatform> {
  return startGatewayOperation(options);
}

/** Promise adapter for hosts that create a standalone gateway. */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  return runRouteKitEffect(startGatewayEffect(options));
}
