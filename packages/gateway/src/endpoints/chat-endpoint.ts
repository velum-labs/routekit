import { Effect } from "effect";

import { effectiveModel, isStream, withDefaultModel } from "../adapters/chat.js";
import {
  isCursorChatBody,
  resolveCursorModelSelection,
  translateCursorRequest
} from "../adapters/cursor.js";
import {
  routeKitRequestValidationErrorOf,
  withReasoningSelection
} from "../adapters/openai-chat-wire.js";
import type { WireRejection } from "../adapters/validate.js";
import { validateChatRequest, validateResponsesRequest } from "../adapters/validate.js";
import type { Backend } from "../providers/backend.js";
import {
  type CompositionalRoutingRuntime,
  compositionalRoutingAttribution,
  evalAutoRouterRejection,
  evalRequestAttribution,
  resolveConfiguredAutoRoutingModel
} from "../routing/eval-policy.js";
import { extractClassifiableRequestText } from "../services/request-classifier/service.js";
import { deriveRoutingRequirements } from "../routing/requirements.js";
import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointModelCall,
  EndpointObserver,
  EndpointProgram
} from "./endpoint-module.js";
import { GatewayEndpoint, withEndpointPlatform } from "./endpoint-module.js";

export type ChatOperation = "chat" | "cursor-chat" | "embeddings";

type ChatRequest = Readonly<{ context: EndpointContext; operation: ChatOperation }>;

export type ChatEndpointDependencies = Readonly<{
  backend: Backend;
  compositionalRouting?: CompositionalRoutingRuntime;
  rejectInvalid(context: EndpointContext, rejection: WireRejection | undefined): boolean;
  attribution(requested: string | undefined): EndpointModelCall["attribution"];
}>;

export class ChatEndpoint extends GatewayEndpoint<ChatOperation> {
  constructor(
    authenticate: EndpointAuthenticator,
    dependencies: ChatEndpointDependencies,
    observe?: EndpointObserver
  ) {
    super(
      "chat",
      authenticate,
      (context, operation) => executeChatRequest(dependencies, { context, operation }),
      observe
    );
  }

  matches(method: string, path: string): boolean {
    return (
      method === "POST" &&
      (path === "/v1/chat/completions" ||
        path === "/chat/completions" ||
        path === "/v1/cursor/chat/completions" ||
        path === "/v1/embeddings")
    );
  }

  protected decodeOperation(context: EndpointContext): ChatOperation {
    if (context.url.pathname === "/v1/cursor/chat/completions") return "cursor-chat";
    if (context.url.pathname === "/v1/embeddings") return "embeddings";
    return "chat";
  }
}

function executeChatRequest(
  dependencies: ChatEndpointDependencies,
  request: ChatRequest
): EndpointProgram {
  return Effect.gen(function* () {
    const { backend, rejectInvalid, attribution } = dependencies;
    const { context, operation } = request;
    const raw = yield* context.transport.readJson();
    if (raw === undefined) return;
    const requestContext = { headers: context.headers };
    const requestEvalAttribution = evalRequestAttribution(context.headers);
    const rawModel =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as { model?: unknown }).model
        : undefined;

    if (operation === "chat") {
      if (rejectInvalid(context, validateChatRequest(raw))) return;
      const evalRejection = evalAutoRouterRejection(context.headers, rawModel);
      if (evalRejection !== undefined) {
        context.transport.writeJson(400, {
          error: { message: evalRejection, type: "invalid_request_error" }
        });
        return;
      }
      let compositionalRouting: ReturnType<typeof compositionalRoutingAttribution> | undefined;
      const resolvedModel = yield* resolveConfiguredAutoRoutingModel({
        headers: context.headers,
        model: typeof rawModel === "string" ? rawModel : undefined,
        requestText: extractClassifiableRequestText(raw),
        requirements: deriveRoutingRequirements("chat", raw),
        compositionalRouting: dependencies.compositionalRouting,
        onCompositionalObservation: (observation) => {
          if (observation.status === "decided") {
            compositionalRouting = compositionalRoutingAttribution(observation);
          }
        }
      });
      const routed =
        resolvedModel !== undefined && resolvedModel !== rawModel
          ? { ...(raw as Record<string, unknown>), model: resolvedModel }
          : raw;
      const body = withDefaultModel(routed, backend.defaultModel);
      context.transport.dispatch({
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        ...(typeof rawModel === "string" ? { requestedModel: rawModel } : {}),
        attribution: {
          ...attribution(effectiveModel(body, backend.defaultModel)),
          ...(requestEvalAttribution === undefined ? {} : { eval: requestEvalAttribution }),
          ...(compositionalRouting === undefined
            ? {}
            : { compositional_routing: compositionalRouting })
        },
        invoke: (callId, signal, onAttribution) =>
          backend.chat(
            body,
            signal,
            withEndpointPlatform(context, {
              modelCallId: callId,
              requestContext,
              responseMode: isStream(body) ? "streaming" : "buffered",
              onAttribution
            })
          )
      });
      return;
    }

    if (operation === "cursor-chat") {
      if (!isCursorChatBody(raw)) {
        context.transport.writeJson(400, {
          error: {
            message: 'request body must be a JSON object with "messages" or "input"',
            type: "invalid_request_error"
          }
        });
        return;
      }
      if ("input" in raw && rejectInvalid(context, validateResponsesRequest(raw))) return;
      const evalRejection = evalAutoRouterRejection(context.headers, raw.model);
      if (evalRejection !== undefined) {
        context.transport.writeJson(400, {
          error: { message: evalRejection, type: "invalid_request_error" }
        });
        return;
      }
      let translated = translateCursorRequest(raw);
      let compositionalRouting: ReturnType<typeof compositionalRoutingAttribution> | undefined;
      const resolvedModel = yield* resolveConfiguredAutoRoutingModel({
        headers: context.headers,
        model: typeof translated.model === "string" ? translated.model : undefined,
        requestText: extractClassifiableRequestText(raw),
        requirements: deriveRoutingRequirements("chat", translated),
        compositionalRouting: dependencies.compositionalRouting,
        onCompositionalObservation: (observation) => {
          if (observation.status === "decided") {
            compositionalRouting = compositionalRoutingAttribution(observation);
          }
        }
      });
      if (resolvedModel !== undefined && resolvedModel !== translated.model) {
        translated = { ...translated, model: resolvedModel };
      }
      const selection = resolveCursorModelSelection(
        translated.model,
        backend.ports.models.list() ?? [],
        backend.ports.models.reasoning
      );
      if (selection !== undefined) {
        translated = withReasoningSelection(
          { ...translated, model: selection.model },
          selection.reasoningEffort === undefined
            ? { mode: "auto" }
            : { mode: "effort", effort: selection.reasoningEffort }
        );
      }
      const validationError = routeKitRequestValidationErrorOf(translated);
      if (validationError !== undefined) {
        context.transport.writeJson(400, {
          error: {
            type: "invalid_request_error",
            code: validationError.code,
            param: validationError.path,
            message: validationError.message
          }
        });
        return;
      }
      if (rejectInvalid(context, validateChatRequest(translated))) return;
      const body = withDefaultModel(translated, backend.defaultModel);
      context.transport.dispatch({
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        ...(raw.model === undefined ? {} : { requestedModel: raw.model }),
        attribution: {
          ...attribution(effectiveModel(body, backend.defaultModel)),
          ...(requestEvalAttribution === undefined ? {} : { eval: requestEvalAttribution }),
          ...(compositionalRouting === undefined
            ? {}
            : { compositional_routing: compositionalRouting })
        },
        invoke: (callId, signal, onAttribution) =>
          backend.chat(
            body,
            signal,
            withEndpointPlatform(context, {
              modelCallId: callId,
              requestContext,
              responseMode: isStream(body) ? "streaming" : "buffered",
              onAttribution
            })
          )
      });
      return;
    }

    const body = withDefaultModel(raw, backend.defaultModel);
    context.transport.dispatch({
      dialect: "openai-embeddings",
      body,
      defaultModel: backend.defaultModel,
      attribution: attribution(effectiveModel(body, backend.defaultModel)),
      invoke: (callId, signal, onAttribution) =>
        backend.embeddings(
          body,
          signal,
          withEndpointPlatform(context, {
            modelCallId: callId,
            requestContext,
            responseMode: isStream(body) ? "streaming" : "buffered",
            onAttribution
          })
        )
    });
  });
}
