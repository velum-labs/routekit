import type { RequestAttribution } from "@velum-labs/routekit-contracts";

import {
  type AnthropicRequest,
  handleAnthropicMessages,
  handleCountTokens,
  resolveClaudeModelSelection,
  withClaudeReasoningSelection
} from "../adapters/anthropic.js";
import { isStream } from "../adapters/chat.js";
import type { WireRejection } from "../adapters/validate.js";
import {
  decodeValidatedAnthropicRequest,
  validateAnthropicRequest,
  validateCountTokensRequest
} from "../adapters/validate.js";
import { type Backend, type BackendModelRoute, type BackendRequestOptions } from "../backend.js";
import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointModelCall,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type AnthropicMessagesOperation = "messages" | "count-tokens";

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
  ): Promise<Response>;
}>;

type AnthropicTokenCountRelay = Readonly<{
  countTokens(
    headers: EndpointContext["headers"],
    body: AnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response>;
}>;

export type AnthropicEndpointDependencies = Readonly<{
  backend: Backend;
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
      async (context, operation) =>
        await executeAnthropicRequest(dependencies, { context, operation }),
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

async function executeAnthropicRequest(
  dependencies: AnthropicEndpointDependencies,
  request: AnthropicMessagesRequest
): Promise<void> {
  const { backend, rejectInvalid } = dependencies;
  const { context, operation } = request;
  const raw = await context.transport.readJson();
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
      await transport.pipe(
        await dependencies.tokenCountRelay.countTokens(
          headers,
          route?.provider === "claude-code" ? withModel(body, route.nativeId) : body
        )
      );
      return;
    }
    await transport.pipe(handleCountTokens(body));
    return;
  }

  if (rejectInvalid(context, validateAnthropicRequest(raw))) return;
  const rawBody = decodeValidatedAnthropicRequest(raw);
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
    await transport.dispatch({
      dialect: "anthropic-messages",
      body,
      defaultModel: backend.defaultModel,
      attribution: {
        effective_model: canonicalModel ?? rawBody.model,
        native_model: route.nativeId,
        provider: route.provider,
        billing_mode: "subscription"
      },
      invoke: (_callId, signal, onAttribution) =>
        dependencies.requestRelay?.relay(headers, relayBody, signal, {
          responseMode: isStream(body) ? "streaming" : "buffered",
          onAttribution
        }) as Promise<Response>
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
    await transport.dispatch({
      dialect: "anthropic-messages",
      body,
      defaultModel: backend.defaultModel,
      attribution: {
        effective_model: requestedModel ?? "claude-code/default",
        ...(requestedModel !== undefined ? { native_model: requestedModel } : {}),
        provider: "claude-code",
        billing_mode: "subscription"
      },
      invoke: (_callId, signal, onAttribution) =>
        dependencies.requestRelay?.relay(headers, body, signal, {
          responseMode: isStream(body) ? "streaming" : "buffered",
          onAttribution
        }) as Promise<Response>
    });
    return;
  }
  await transport.dispatch({
    dialect: "anthropic-messages",
    body,
    defaultModel: backend.defaultModel,
    attribution: dependencies.attribution(resolvedModel, "claude-code"),
    invoke: (callId, signal, onAttribution) =>
      handleAnthropicMessages(backend, body, callId, signal, {
        requestContext: { headers },
        responseMode: isStream(body) ? "streaming" : "buffered",
        onAttribution
      })
  });
}
