import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import { Effect } from "effect";

import { handleAnthropicMessages, handleCountTokens } from "../adapters/anthropic.js";
import {
  resolveClaudeModelSelection,
  withClaudeReasoningSelection
} from "../adapters/anthropic-models.js";
import type { AnthropicRequest } from "../adapters/anthropic-wire.js";
import { isStream } from "../adapters/chat.js";
import type { WireRejection } from "../adapters/validate.js";
import {
  decodeValidatedAnthropicRequest,
  validateAnthropicRequest,
  validateCountTokensRequest
} from "../adapters/validate.js";
import {
  type Backend,
  type BackendModelRoute,
  type BackendRequest,
  type BackendRequestOptions
} from "../backend.js";
import {
  type AutoRoutingDecision,
  evalAutoRouterRejection,
  type RoutingPolicyReader,
  resolveAutoRoutingModel
} from "../eval-policy.js";
import {
  extractClassifiableRequestText,
  type RequestClassifierService
} from "../request-classifier.js";
import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointModelCall,
  EndpointObserver,
  EndpointProgram
} from "./endpoint-module.js";
import { GatewayEndpoint, withEndpointPlatform } from "./endpoint-module.js";

export type AnthropicMessagesOperation = "messages" | "count-tokens";

const autoRoutingAttribution = (decision: AutoRoutingDecision) => ({
  profile_id: decision.profileId,
  selected_model: decision.selectedModel,
  evidence_digest: decision.evidenceDigest,
  scores: decision.scores.map((score) => ({
    profile_id: score.profileId,
    probability: score.probability
  }))
});

type AnthropicMessagesRequest = Readonly<{
  context: EndpointContext;
  operation: AnthropicMessagesOperation;
}>;

type AnthropicRequestRelay = Readonly<{
  shouldRelay(
    headers: EndpointContext["headers"],
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: EndpointContext["headers"],
    body: AnthropicRequest,
    signal?: AbortSignal,
    options?: Pick<BackendRequestOptions, "onAttribution" | "responseMode">
  ): BackendRequest;
}>;

type AnthropicTokenCountRelay = Readonly<{
  countTokens(
    headers: EndpointContext["headers"],
    body: AnthropicRequest,
    signal?: AbortSignal
  ): BackendRequest;
}>;

export type AnthropicEndpointDependencies = Readonly<{
  backend: Backend;
  policyReader?: RoutingPolicyReader;
  classifier?: RequestClassifierService;
  requestRelay?: AnthropicRequestRelay;
  tokenCountRelay?: AnthropicTokenCountRelay;
  rejectInvalid(context: EndpointContext, rejection: WireRejection | undefined): boolean;
  attribution(
    requested: string | undefined,
    nativeProvider?: "claude-code"
  ): Partial<RequestAttribution>;
}>;

export class AnthropicMessagesEndpoint extends GatewayEndpoint<AnthropicMessagesOperation> {
  constructor(
    authenticate: EndpointAuthenticator,
    dependencies: AnthropicEndpointDependencies,
    observe?: EndpointObserver
  ) {
    super(
      "anthropic-messages",
      authenticate,
      (context, operation) => executeAnthropicRequest(dependencies, { context, operation }),
      observe
    );
  }

  matches(method: string, path: string): boolean {
    return method === "POST" && (path === "/v1/messages" || path === "/v1/messages/count_tokens");
  }

  protected decodeOperation(context: EndpointContext): AnthropicMessagesOperation {
    return context.url.pathname.endsWith("/count_tokens") ? "count-tokens" : "messages";
  }
}

function catalogRoutes(backend: Backend): BackendModelRoute[] {
  if (backend.ports.models.kind === "static-model") return [];
  return (backend.ports.models.list() ?? []).flatMap((model) => {
    const route = backend.ports.models.resolveRoute(model);
    return route === undefined ? [] : [route];
  });
}

function withModel<T extends Record<string, unknown>>(body: T, model: string): T {
  return { ...body, model };
}

function withoutUnsupportedReasoning(body: AnthropicRequest): AnthropicRequest {
  const { thinking: _thinking, output_config: outputConfig, ...rest } = body;
  if (outputConfig === undefined || outputConfig === null) return rest;
  const { effort: _effort, ...remainingOutputConfig } = outputConfig;
  return Object.keys(remainingOutputConfig).length === 0
    ? rest
    : { ...rest, output_config: remainingOutputConfig };
}

function executeAnthropicRequest(
  dependencies: AnthropicEndpointDependencies,
  request: AnthropicMessagesRequest
): EndpointProgram {
  return Effect.gen(function* () {
    const { backend, rejectInvalid } = dependencies;
    const { context, operation } = request;
    const raw = yield* context.transport.readJson();
    if (raw === undefined) return;
    const { headers, transport } = context;
    const selectionOf = (model: string | undefined) =>
      resolveClaudeModelSelection(model, backend.ports.models.list() ?? [], catalogRoutes(backend));

    if (operation === "count-tokens") {
      if (rejectInvalid(context, validateCountTokensRequest(raw))) return;
      const rawBody = decodeValidatedAnthropicRequest(raw);
      const selection = selectionOf(rawBody.model);
      if (selection.status === "unsupported_effort" || selection.status === "ambiguous_model") {
        transport.writeJson(400, {
          type: "error",
          error: { type: "invalid_request_error", message: selection.message }
        });
        return;
      }
      const alias = selection.model.length > 0 ? selection.model : undefined;
      const route = backend.ports.models.resolveRoute(alias, "claude-code");
      if (
        alias !== undefined &&
        backend.ports.models.kind === "model-catalog" &&
        route === undefined
      ) {
        transport.writeJson(400, {
          type: "error",
          error: { type: "invalid_request_error", message: `unknown model: ${alias}` }
        });
        return;
      }
      const body =
        selection.status === "resolved" && alias !== undefined && alias !== rawBody.model
          ? withModel(rawBody, alias)
          : rawBody;
      if (
        dependencies.tokenCountRelay !== undefined &&
        (route?.provider === "claude-code" || backend.ports.models.kind === "static-model")
      ) {
        transport.pipe(
          yield* dependencies.tokenCountRelay.countTokens(
            headers,
            route?.provider === "claude-code" ? withModel(body, route.nativeId) : body
          )
        );
        return;
      }
      transport.pipe(handleCountTokens(body));
      return;
    }

    if (rejectInvalid(context, validateAnthropicRequest(raw))) return;
    const decodedBody = decodeValidatedAnthropicRequest(raw);
    const evalRejection = evalAutoRouterRejection(headers, decodedBody.model);
    if (evalRejection !== undefined) {
      transport.writeJson(400, {
        type: "error",
        error: { type: "invalid_request_error", message: evalRejection }
      });
      return;
    }
    let autoRouting: ReturnType<typeof autoRoutingAttribution> | undefined;
    const autoModel = yield* resolveAutoRoutingModel({
      headers,
      model: decodedBody.model,
      requestText: extractClassifiableRequestText(decodedBody),
      policyReader: dependencies.policyReader,
      classifier: dependencies.classifier,
      servesModel: (model) => backend.ports.models.serves(model),
      onDecision: (decision) => {
        autoRouting = autoRoutingAttribution(decision);
      }
    });
    const rawBody =
      autoModel !== undefined && autoModel !== decodedBody.model
        ? withModel(decodedBody, autoModel)
        : decodedBody;
    if (rawBody.model === undefined && backend.defaultModel === undefined) {
      transport.writeJson(503, {
        type: "error",
        error: { type: "unavailable", message: "no model is available; configure a provider" }
      });
      return;
    }
    const selection = selectionOf(rawBody.model);
    if (selection.status === "unsupported_effort" || selection.status === "ambiguous_model") {
      transport.writeJson(400, {
        type: "error",
        error: { type: "invalid_request_error", message: selection.message }
      });
      return;
    }
    const resolvedModel =
      selection.status === "resolved"
        ? selection.model
        : selection.model.length > 0
          ? selection.model
          : undefined;
    const route = backend.ports.models.resolveRoute(resolvedModel, "claude-code");
    const canonicalModel = route?.publicId ?? resolvedModel;
    const normalized =
      selection.status === "resolved" &&
      selection.selection.mode === "auto" &&
      route !== undefined &&
      route.reasoning?.status !== "supported"
        ? withoutUnsupportedReasoning(rawBody)
        : rawBody;
    const body =
      selection.status === "resolved"
        ? withClaudeReasoningSelection(
            canonicalModel === normalized.model || canonicalModel === undefined
              ? normalized
              : withModel(normalized, canonicalModel),
            selection.selection
          )
        : canonicalModel === normalized.model || canonicalModel === undefined
          ? normalized
          : withModel(normalized, canonicalModel);
    const requestedModel = typeof body.model === "string" ? body.model : undefined;

    if (dependencies.requestRelay !== undefined && route?.provider === "claude-code") {
      const relayBody = withClaudeReasoningSelection(
        withModel(rawBody, route.nativeId),
        selection.status === "resolved" ? selection.selection : { mode: "auto" }
      );
      const relay = dependencies.requestRelay;
      transport.dispatch({
        dialect: "anthropic-messages",
        body,
        defaultModel: backend.defaultModel,
        ...(decodedBody.model === undefined ? {} : { requestedModel: decodedBody.model }),
        attribution: {
          effective_model: canonicalModel ?? rawBody.model,
          native_model: route.nativeId,
          provider: route.provider,
          billing_mode: "subscription",
          ...(autoRouting === undefined ? {} : { auto_routing: autoRouting })
        },
        invoke: (_callId, signal, onAttribution) =>
          relay.relay(headers, relayBody, signal, {
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          })
      });
      return;
    }
    if (
      dependencies.requestRelay !== undefined &&
      backend.ports.models.kind === "static-model" &&
      dependencies.requestRelay.shouldRelay(headers, requestedModel, (model) =>
        backend.ports.models.serves(model)
      )
    ) {
      const relay = dependencies.requestRelay;
      transport.dispatch({
        dialect: "anthropic-messages",
        body,
        defaultModel: backend.defaultModel,
        ...(decodedBody.model === undefined ? {} : { requestedModel: decodedBody.model }),
        attribution: {
          effective_model: requestedModel ?? "claude-code/default",
          ...(requestedModel !== undefined ? { native_model: requestedModel } : {}),
          provider: "claude-code",
          billing_mode: "subscription",
          ...(autoRouting === undefined ? {} : { auto_routing: autoRouting })
        },
        invoke: (_callId, signal, onAttribution) =>
          relay.relay(headers, body, signal, {
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          })
      });
      return;
    }
    transport.dispatch({
      dialect: "anthropic-messages",
      body,
      defaultModel: backend.defaultModel,
      ...(decodedBody.model === undefined ? {} : { requestedModel: decodedBody.model }),
      attribution: {
        ...dependencies.attribution(resolvedModel, "claude-code"),
        ...(autoRouting === undefined ? {} : { auto_routing: autoRouting })
      },
      invoke: (callId, signal, onAttribution) =>
        handleAnthropicMessages(
          backend,
          body,
          callId,
          signal,
          withEndpointPlatform(context, {
            requestContext: { headers },
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          })
        )
    });
  });
}
