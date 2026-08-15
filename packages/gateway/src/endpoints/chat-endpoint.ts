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
import type { Backend } from "../backend.js";
import { evalAutoRouterRejection } from "../eval-policy.js";
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

    if (operation === "chat") {
      if (rejectInvalid(context, validateChatRequest(raw))) return;
      const evalRejection = evalAutoRouterRejection(
        context.headers,
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as { model?: unknown }).model
          : undefined
      );
      if (evalRejection !== undefined) {
        context.transport.writeJson(400, {
          error: { message: evalRejection, type: "invalid_request_error" }
        });
        return;
      }
      const body = withDefaultModel(raw, backend.defaultModel);
      context.transport.dispatch({
        dialect: "openai-chat",
        body,
        defaultModel: backend.defaultModel,
        attribution: attribution(effectiveModel(body, backend.defaultModel)),
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
      let translated = translateCursorRequest(raw);
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
        attribution: attribution(effectiveModel(body, backend.defaultModel)),
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
