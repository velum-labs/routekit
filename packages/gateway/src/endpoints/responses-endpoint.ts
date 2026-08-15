import type { RequestAttribution } from "@velum-labs/routekit-contracts";
import { Effect } from "effect";

import { isStream } from "../adapters/chat.js";
import { droppedField } from "../adapters/dropped.js";
import {
  prepareResponsesReasoningInput,
  wrapResponsesReasoningResponse
} from "../adapters/openai-responses-wire.js";
import { handleResponses } from "../adapters/responses.js";
import type { ResponsesRequest } from "../adapters/responses-wire.js";
import type { WireRejection } from "../adapters/validate.js";
import { decodeValidatedResponsesRequest, validateResponsesRequest } from "../adapters/validate.js";
import {
  type Backend,
  type BackendModelRoute,
  type BackendRequest,
  type BackendRequestOptions
} from "../backend.js";
import { gatewayTry } from "../effect/gateway.js";
import {
  evalAutoRouterRejection,
  resolveAutoRoutingModel,
  type RoutingPolicyReader
} from "../eval-policy.js";
import { UnknownModelError } from "../router.js";
import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointModelCall,
  EndpointObserver,
  EndpointProgram
} from "./endpoint-module.js";
import { GatewayEndpoint, withEndpointPlatform } from "./endpoint-module.js";

export type ResponsesOperation = "responses";

type ResponsesEndpointRequest = Readonly<{
  context: EndpointContext;
  operation: ResponsesOperation;
}>;

type ResponsesRelay = Readonly<{
  shouldRelay(
    headers: EndpointContext["headers"],
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: EndpointContext["headers"],
    body: ResponsesRequest,
    signal?: AbortSignal,
    options?: Pick<BackendRequestOptions, "onAttribution" | "responseMode">
  ): BackendRequest;
}>;

export type ResponsesEndpointDependencies = Readonly<{
  backend: Backend;
  policyReader?: RoutingPolicyReader;
  providerRelay?: ResponsesRelay;
  clientRelay?: ResponsesRelay;
  rejectInvalid(context: EndpointContext, rejection: WireRejection | undefined): boolean;
  attribution(requested: string | undefined, nativeProvider?: "codex"): Partial<RequestAttribution>;
}>;

export class ResponsesEndpoint extends GatewayEndpoint<ResponsesOperation> {
  constructor(
    authenticate: EndpointAuthenticator,
    dependencies: ResponsesEndpointDependencies,
    observe?: EndpointObserver
  ) {
    super(
      "responses",
      authenticate,
      (context, operation) => executeResponsesRequest(dependencies, { context, operation }),
      observe
    );
  }

  matches(method: string, path: string): boolean {
    return (
      method === "POST" && (path === "/v1/responses" || path === "/backend-api/codex/responses")
    );
  }

  protected decodeOperation(_context: EndpointContext): ResponsesOperation {
    return "responses";
  }
}

function withModel<T extends Record<string, unknown>>(body: T, model: string): T {
  return { ...body, model };
}

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

function resolveNativeRoute(
  backend: Backend,
  requested: string | undefined
): BackendModelRoute | undefined {
  const models = backend.ports.models;
  if (models.kind === "static-model") return undefined;
  const route = models.resolveRoute(requested, "codex");
  if (route === undefined && requested !== undefined) {
    throw new UnknownModelError(requested);
  }
  return route;
}

function executeResponsesRequest(
  dependencies: ResponsesEndpointDependencies,
  request: ResponsesEndpointRequest
): EndpointProgram {
  return Effect.gen(function* () {
    const { backend, rejectInvalid } = dependencies;
    const { context } = request;
    const raw = yield* context.transport.readJson();
    if (raw === undefined) return;
    if (rejectInvalid(context, validateResponsesRequest(raw))) return;
    const decodedBody = decodeValidatedResponsesRequest(raw);
    const evalRejection = evalAutoRouterRejection(context.headers, decodedBody.model);
    if (evalRejection !== undefined) {
      context.transport.writeJson(400, {
        error: { message: evalRejection, type: "invalid_request_error" }
      });
      return;
    }
    const autoModel = yield* resolveAutoRoutingModel({
      headers: context.headers,
      model: decodedBody.model,
      policyReader: dependencies.policyReader,
      servesModel: (model) => backend.ports.models.serves(model)
    });
    const body =
      autoModel !== undefined && autoModel !== decodedBody.model
        ? withModel(decodedBody, autoModel)
        : decodedBody;
    const requestedModel = typeof body.model === "string" ? body.model : undefined;
    const resolved = yield* gatewayTry(() =>
      dependencies.providerRelay === undefined
        ? backend.ports.models.resolveRoute(requestedModel, "codex")
        : resolveNativeRoute(backend, requestedModel)
    ).pipe(
      Effect.map((route) => ({ ok: true as const, route })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    );
    if (!resolved.ok) {
      context.transport.dispatch({
        dialect: "openai-responses",
        body,
        defaultModel: backend.defaultModel,
        attribution: dependencies.attribution(requestedModel, "codex"),
        invoke: () => Effect.fail(resolved.error)
      });
      return;
    }
    const route = resolved.route;
    const routedBody = withoutStaleCodexIdentity(body, route);
    const canonicalBody =
      route === undefined || route.publicId === requestedModel
        ? routedBody
        : withModel(routedBody, route.publicId);

    if (dependencies.providerRelay !== undefined && route?.provider === "codex") {
      const owner = { provider: "codex", nativeModel: route.nativeId };
      const prepared = prepareResponsesReasoningInput(withModel(body, route.nativeId), {
        mode: "forward",
        owner
      });
      const relay = dependencies.providerRelay;
      context.transport.dispatch({
        dialect: "openai-responses",
        body: canonicalBody,
        defaultModel: backend.defaultModel,
        attribution: {
          effective_model: route.publicId,
          native_model: route.nativeId,
          provider: route.provider,
          billing_mode: "subscription"
        },
        invoke: (_callId, signal, onAttribution) =>
          Effect.gen(function* () {
            if (prepared.dropped > 0) {
              droppedField("responses", "encrypted_content", "input.reasoning");
            }
            const response = yield* relay.relay(context.headers, prepared.body, signal, {
              responseMode: isStream(body) ? "streaming" : "buffered",
              onAttribution
            });
            return yield* wrapResponsesReasoningResponse(response, owner);
          })
      });
      return;
    }

    if (
      route === undefined &&
      dependencies.clientRelay !== undefined &&
      (dependencies.providerRelay === undefined || backend.ports.models.kind === "static-model") &&
      dependencies.clientRelay.shouldRelay(context.headers, requestedModel, (model) =>
        backend.ports.models.serves(model)
      )
    ) {
      const owner = {
        provider: "codex",
        nativeModel: requestedModel ?? "codex/default"
      };
      const prepared = prepareResponsesReasoningInput(body, {
        mode: "forward",
        owner
      });
      const relay = dependencies.clientRelay;
      context.transport.dispatch({
        dialect: "openai-responses",
        body,
        defaultModel: backend.defaultModel,
        attribution: {
          effective_model: requestedModel ?? "codex/default",
          ...(requestedModel !== undefined ? { native_model: requestedModel } : {}),
          provider: "codex",
          billing_mode: "client_auth"
        },
        invoke: (_callId, signal, onAttribution) =>
          Effect.gen(function* () {
            if (prepared.dropped > 0) {
              droppedField("responses", "encrypted_content", "input.reasoning");
            }
            const response = yield* relay.relay(context.headers, prepared.body, signal, {
              responseMode: isStream(body) ? "streaming" : "buffered",
              onAttribution
            });
            return yield* wrapResponsesReasoningResponse(response, owner);
          })
      });
      return;
    }

    context.transport.dispatch({
      dialect: "openai-responses",
      body: canonicalBody,
      defaultModel: backend.defaultModel,
      attribution: dependencies.attribution(
        requestedModel,
        dependencies.providerRelay !== undefined ? "codex" : undefined
      ),
      invoke: (callId, signal, onAttribution) =>
        handleResponses(
          backend,
          canonicalBody,
          callId,
          signal,
          withEndpointPlatform(context, {
            requestContext: { headers: context.headers },
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          })
        )
    });
  });
}
