import { backendPorts, type Backend } from "../backend.js";
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
import {
  validateChatRequest,
  validateResponsesRequest
} from "../adapters/validate.js";
import type {
  EndpointAuthenticator,
  EndpointBodyReader,
  EndpointContext,
  EndpointJsonWriter,
  EndpointModelCall,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type ChatOperation = "chat" | "cursor-chat" | "embeddings";

type ChatRequest = Readonly<{ context: EndpointContext; operation: ChatOperation }>;

export type ChatEndpointDependencies = Readonly<{
  backend: Backend;
  readBody: EndpointBodyReader;
  writeJson: EndpointJsonWriter;
  rejectInvalid(response: EndpointContext["response"], rejection: WireRejection | undefined): boolean;
  dispatch(context: EndpointContext, call: EndpointModelCall): Promise<void>;
  attribution(
    requested: string | undefined
  ): EndpointModelCall["attribution"];
}>;

export class ChatEndpoint extends GatewayEndpoint<
  ChatOperation,
  ChatRequest,
  ChatRequest,
  ChatRequest,
  ChatRequest
> {
  constructor(
    authenticate: EndpointAuthenticator,
    dependencies: ChatEndpointDependencies,
    observe?: EndpointObserver
  ) {
    super(
      "chat",
      authenticate,
      {
        decode: (context, operation) => ({ context, operation }),
        resolve: (request) => request,
        execute: async (request) => {
          await executeChatRequest(dependencies, request);
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

async function executeChatRequest(
  dependencies: ChatEndpointDependencies,
  request: ChatRequest
): Promise<void> {
  const { backend, readBody, writeJson, rejectInvalid, dispatch, attribution } = dependencies;
  const { context, operation } = request;
  const raw = await readBody(context);
  if (raw === undefined) return;
  const requestContext = { headers: context.request.headers };

  if (operation === "chat") {
    if (rejectInvalid(context.response, validateChatRequest(raw))) return;
    const body = withDefaultModel(raw, backend.defaultModel);
    await dispatch(context, {
      dialect: "openai-chat",
      body,
      defaultModel: backend.defaultModel,
      attribution: attribution(effectiveModel(body, backend.defaultModel)),
      invoke: (callId, signal, onAttribution) =>
        backend.chat(body, signal, {
          modelCallId: callId,
          requestContext,
          responseMode: isStream(body) ? "streaming" : "buffered",
          onAttribution
        })
    });
    return;
  }

  if (operation === "cursor-chat") {
    if (!isCursorChatBody(raw)) {
      writeJson(context.response, 400, {
        error: {
          message: 'request body must be a JSON object with "messages" or "input"',
          type: "invalid_request_error"
        }
      });
      return;
    }
    if ("input" in raw && rejectInvalid(context.response, validateResponsesRequest(raw))) return;
    let translated = translateCursorRequest(raw);
    const selection = resolveCursorModelSelection(
      translated.model,
      backendPorts(backend).models.list() ?? [],
      backendPorts(backend).models.reasoning
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
      writeJson(context.response, 400, {
        error: {
          type: "invalid_request_error",
          code: validationError.code,
          param: validationError.path,
          message: validationError.message
        }
      });
      return;
    }
    if (rejectInvalid(context.response, validateChatRequest(translated))) return;
    const body = withDefaultModel(translated, backend.defaultModel);
    await dispatch(context, {
      dialect: "openai-chat",
      body,
      defaultModel: backend.defaultModel,
      attribution: attribution(effectiveModel(body, backend.defaultModel)),
      invoke: (callId, signal, onAttribution) =>
        backend.chat(body, signal, {
          modelCallId: callId,
          requestContext,
          responseMode: isStream(body) ? "streaming" : "buffered",
          onAttribution
        })
    });
    return;
  }

  const body = withDefaultModel(raw, backend.defaultModel);
  await dispatch(context, {
    dialect: "openai-embeddings",
    body,
    defaultModel: backend.defaultModel,
    attribution: attribution(effectiveModel(body, backend.defaultModel)),
    invoke: (callId, signal, onAttribution) =>
      backend.embeddings(body, signal, {
        modelCallId: callId,
        requestContext,
        responseMode: isStream(body) ? "streaming" : "buffered",
        onAttribution
      })
  });
}
