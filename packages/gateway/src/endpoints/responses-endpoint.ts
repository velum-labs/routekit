import type { RequestAttribution } from "@velum-labs/routekit-contracts";

import { isStream } from "../adapters/chat.js";
import { droppedField } from "../adapters/dropped.js";
import {
  prepareResponsesReasoningInput,
  wrapResponsesReasoningResponse
} from "../adapters/openai-responses-wire.js";
import type { ResponsesRequest } from "../adapters/responses.js";
import { handleResponses } from "../adapters/responses.js";
import type { WireRejection } from "../adapters/validate.js";
import {
  decodeValidatedResponsesRequest,
  validateResponsesRequest
} from "../adapters/validate.js";
import {
  backendPorts,
  type Backend,
  type BackendModelRoute,
  type BackendRequestOptions
} from "../backend.js";
import { UnknownModelError } from "../router.js";
import type {
  EndpointAuthenticator,
  EndpointBodyReader,
  EndpointContext,
  EndpointModelCall,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type ResponsesOperation = "responses";

type ResponsesEndpointRequest = Readonly<{
  context: EndpointContext;
  operation: ResponsesOperation;
}>;

type ResponsesRelay = Readonly<{
  shouldRelay(
    headers: EndpointContext["request"]["headers"],
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: EndpointContext["request"]["headers"],
    body: ResponsesRequest,
    signal?: AbortSignal,
    options?: Pick<BackendRequestOptions, "onAttribution" | "responseMode">
  ): Promise<Response>;
}>;

export type ResponsesEndpointDependencies = Readonly<{
  backend: Backend;
  providerRelay?: ResponsesRelay;
  clientRelay?: ResponsesRelay;
  readBody: EndpointBodyReader;
  rejectInvalid(response: EndpointContext["response"], rejection: WireRejection | undefined): boolean;
  dispatch(context: EndpointContext, call: EndpointModelCall): Promise<void>;
  attribution(
    requested: string | undefined,
    nativeProvider?: "codex"
  ): Partial<RequestAttribution>;
}>;

export class ResponsesEndpoint extends GatewayEndpoint<
  ResponsesOperation,
  ResponsesEndpointRequest,
  ResponsesEndpointRequest,
  ResponsesEndpointRequest,
  ResponsesEndpointRequest
> {
  constructor(
    authenticate: EndpointAuthenticator,
    dependencies: ResponsesEndpointDependencies,
    observe?: EndpointObserver
  ) {
    super(
      "responses",
      authenticate,
      {
        decode: (context, operation) => ({ context, operation }),
        resolve: (request) => request,
        execute: async (request) => {
          await executeResponsesRequest(dependencies, request);
          return request;
        },
        observe: (request) => request,
        encode: () => {}
      },
      observe
    );
  }

  matches(method: string, path: string): boolean {
    return (
      method === "POST" &&
      (path === "/v1/responses" || path === "/backend-api/codex/responses")
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
  const models = backendPorts(backend).models;
  if (models.kind === "static-model") return undefined;
  const route = models.resolveRoute(requested, "codex");
  if (route === undefined && requested !== undefined) {
    throw new UnknownModelError(requested);
  }
  return route;
}

async function executeResponsesRequest(
  dependencies: ResponsesEndpointDependencies,
  request: ResponsesEndpointRequest
): Promise<void> {
  const { backend, readBody, rejectInvalid, dispatch } = dependencies;
  const { context } = request;
  const raw = await readBody(context);
  if (raw === undefined) return;
  if (rejectInvalid(context.response, validateResponsesRequest(raw))) return;
  const body = decodeValidatedResponsesRequest(raw);
  const requestedModel = typeof body.model === "string" ? body.model : undefined;
  let route: BackendModelRoute | undefined;
  try {
    route =
      dependencies.providerRelay === undefined
        ? backendPorts(backend).models.resolveRoute(requestedModel, "codex")
        : resolveNativeRoute(backend, requestedModel);
  } catch (error) {
    await dispatch(context, {
      dialect: "openai-responses",
      body,
      defaultModel: backend.defaultModel,
      attribution: dependencies.attribution(requestedModel, "codex"),
      invoke: async () => {
        throw error;
      }
    });
    return;
  }
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
    await dispatch(context, {
      dialect: "openai-responses",
      body: canonicalBody,
      defaultModel: backend.defaultModel,
      attribution: {
        effective_model: route.publicId,
        native_model: route.nativeId,
        provider: route.provider,
        billing_mode: "subscription"
      },
      invoke: async (_callId, signal, onAttribution) => {
        if (prepared.dropped > 0) {
          droppedField("responses", "encrypted_content", "input.reasoning");
        }
        const response = await dependencies.providerRelay?.relay(
          context.request.headers,
          prepared.body,
          signal,
          {
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          }
        );
        if (response === undefined) throw new Error("provider relay is unavailable");
        return await wrapResponsesReasoningResponse(response, owner);
      }
    });
    return;
  }

  if (
    route === undefined &&
    dependencies.clientRelay !== undefined &&
    (dependencies.providerRelay === undefined ||
      backendPorts(backend).models.kind === "static-model") &&
    dependencies.clientRelay.shouldRelay(
      context.request.headers,
      requestedModel,
      (model) => backendPorts(backend).models.serves(model)
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
    await dispatch(context, {
      dialect: "openai-responses",
      body,
      defaultModel: backend.defaultModel,
      attribution: {
        effective_model: requestedModel ?? "codex/default",
        ...(requestedModel !== undefined ? { native_model: requestedModel } : {}),
        provider: "codex",
        billing_mode: "client_auth"
      },
      invoke: async (_callId, signal, onAttribution) => {
        if (prepared.dropped > 0) {
          droppedField("responses", "encrypted_content", "input.reasoning");
        }
        const response = await dependencies.clientRelay?.relay(
          context.request.headers,
          prepared.body,
          signal,
          {
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          }
        );
        if (response === undefined) throw new Error("client relay is unavailable");
        return await wrapResponsesReasoningResponse(response, owner);
      }
    });
    return;
  }

  await dispatch(context, {
    dialect: "openai-responses",
    body: canonicalBody,
    defaultModel: backend.defaultModel,
    attribution: dependencies.attribution(
      requestedModel,
      dependencies.providerRelay !== undefined ? "codex" : undefined
    ),
    invoke: (callId, signal, onAttribution) =>
      handleResponses(backend, canonicalBody, callId, signal, {
        requestContext: { headers: context.request.headers },
        responseMode: isStream(body) ? "streaming" : "buffered",
        onAttribution
      })
  });
}
