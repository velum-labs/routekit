/**
 * OpenAI Responses adapter. Codex speaks the Responses API exclusively
 * (`wire_api="responses"`; Chat Completions support was removed), so to back it
 * with a local model we translate `/v1/responses` to and from the gateway's
 * OpenAI Chat Completions core.
 *
 * Layers:
 * - `responses-wire.ts` — request types
 * - `responses-codec.ts` — JSON request/response translation
 * - `responses-stream.ts` — SSE translation
 * - `openai-responses-wire.ts` — encrypted-reasoning envelopes
 * - `responses-usage.ts` — usage mapping
 * - this module — HTTP handlers that wire the codec to a `Backend`
 */

import type { Backend, BackendRequestOptions } from "../backend.js";
import { jsonResponse } from "../http-response.js";
import { decodeOpenAiChatResponse } from "../provider-protocol.js";
import { droppedField } from "./dropped.js";
import { reasoningSelectionOf, routeKitRequestValidationErrorOf } from "./openai-chat-wire.js";
import {
  prepareResponsesReasoningInput,
  type ResponsesReasoningInputPolicy,
  type ResponsesReasoningOwner,
  wrapResponsesReasoningResponse
} from "./openai-responses-wire.js";
import {
  chatToResponses,
  isServerWebSearchTool,
  responsesToChat,
  responsesToolRegistry,
  ResponsesTranslationError,
  WEB_SEARCH_TOOL_NAME
} from "./responses-codec.js";
import { openAiSseToResponses } from "./responses-stream.js";
import type { ResponsesRequest } from "./responses-wire.js";
import { composeServerToolStream, runBufferedServerToolLoop } from "./server-tool-loop.js";
import { unwrapUpstreamError } from "./upstream-error.js";
import { resolveWebSearchExecutor } from "./web-search.js";

export type {
  ResponsesRequest,
  ResponsesInputItem
} from "./responses-wire.js";
export type {
  ResponsesToolKind,
  ResponsesToolEntry,
  ResponsesToolRegistry,
  ResponsesTranslationOptions
} from "./responses-codec.js";
export {
  chatToResponses,
  responsesToChat,
  responsesToolRegistry,
  WEB_SEARCH_TOOL_NAME
} from "./responses-codec.js";
export { openAiSseToResponses } from "./responses-stream.js";

function responsesReasoningOwner(
  backend: Backend,
  upstreamModel: string,
  destinationWireShape: string | undefined,
  supportsNativeResponses: boolean
): ResponsesReasoningOwner {
  const route = backend.ports.models.resolveRoute(upstreamModel);
  return route === undefined
    ? {
        // The only Chat backend that reconstructs OpenAI Responses is the
        // Codex bridge. Native Responses fall back to their protocol identity.
        provider:
          !supportsNativeResponses && destinationWireShape === "openai-responses"
            ? "codex"
            : (destinationWireShape ?? "openai-responses"),
        nativeModel: upstreamModel
      }
    : { provider: route.provider, nativeModel: route.nativeId };
}

function recordDroppedEncryptedReasoning(count: number): void {
  if (count > 0) {
    droppedField("responses", "encrypted_content", "input.reasoning");
  }
}

export async function handleResponses(
  backend: Backend,
  body: ResponsesRequest,
  modelCallId?: string,
  signal?: AbortSignal,
  backendOptions: BackendRequestOptions = {}
): Promise<Response> {
  const requestedModel = body.model ?? backend.defaultModel ?? "";
  const validationError = routeKitRequestValidationErrorOf(body);
  if (validationError !== undefined) {
    return jsonResponse(400, {
      error: {
        type: "invalid_request_error",
        code: validationError.code,
        param: validationError.path,
        message: validationError.message
      }
    });
  }
  const nativeEffort = body.reasoning?.effort;
  const envelopeSelection = reasoningSelectionOf(body);
  if (
    typeof nativeEffort === "string" &&
    nativeEffort.length > 0 &&
    envelopeSelection.mode !== "auto"
  ) {
    const same = envelopeSelection.mode === "effort" && envelopeSelection.effort === nativeEffort;
    if (!same) {
      return jsonResponse(400, {
        error: {
          type: "invalid_request_error",
          code: "invalid_reasoning_control",
          param: "reasoning",
          message: "reasoning.effort conflicts with x_routekit.selection"
        }
      });
    }
  }
  const resolvedModel = backend.ports.models.resolve(body.model);
  if (
    body.model !== undefined &&
    backend.ports.models.kind === "model-catalog" &&
    resolvedModel === undefined
  ) {
    return jsonResponse(400, {
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        param: "model",
        message: `unknown model: ${body.model}`
      }
    });
  }
  const upstreamModel = resolvedModel ?? backend.defaultModel;
  if (upstreamModel === undefined) {
    return jsonResponse(503, {
      error: {
        type: "unavailable",
        message: "no model is available; configure a provider"
      }
    });
  }
  const destinationWireShape = backend.ports.models.reasoningWireShape(upstreamModel);
  const responsesPort = backend.ports.responses;
  const supportsNativeResponses =
    responsesPort.kind === "responses" && responsesPort.supports(upstreamModel);
  const reasoningOwner = responsesReasoningOwner(
    backend,
    upstreamModel,
    destinationWireShape,
    supportsNativeResponses
  );
  if (body.previous_response_id != null && !supportsNativeResponses) {
    return jsonResponse(400, {
      error: {
        type: "invalid_request_error",
        code: "unsupported_previous_response_id",
        param: "previous_response_id",
        message:
          "previous_response_id cannot be translated to this destination; replay prior output items in input"
      }
    });
  }
  const requestsEncryptedReasoning =
    Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content");
  const preservesOpaqueReasoning =
    supportsNativeResponses ||
    destinationWireShape === "openai-responses" ||
    destinationWireShape === "routekit-envelope";
  if (supportsNativeResponses && responsesPort.kind === "responses") {
    const prepared = prepareResponsesReasoningInput(body, {
      mode: "forward",
      owner: reasoningOwner
    });
    recordDroppedEncryptedReasoning(prepared.dropped);
    const response = await responsesPort.execute(prepared.body, signal, {
      ...backendOptions,
      modelCallId
    });
    return wrapResponsesReasoningResponse(response, reasoningOwner);
  }
  // Server-executed web search is honored when the caller declared the tool,
  // an executor is available (a provider key exists), and no *client* tool
  // already owns the projected name; otherwise the ingress keeps its
  // honest-drop behavior.
  const declaresWebSearch = body.tools?.some(isServerWebSearchTool) === true;
  const clientNameCollision =
    body.tools?.some((tool) => tool.name === WEB_SEARCH_TOOL_NAME) === true;
  const executor =
    declaresWebSearch && !clientNameCollision ? resolveWebSearchExecutor("responses") : undefined;
  const serverTools = executor !== undefined;
  const toolRegistry = responsesToolRegistry(body, { serverTools });
  const includeCompatibleBody =
    requestsEncryptedReasoning && !preservesOpaqueReasoning
      ? {
          ...body,
          include: body.include?.filter((value) => value !== "reasoning.encrypted_content")
        }
      : body;
  const reasoningPolicy: ResponsesReasoningInputPolicy =
    destinationWireShape === "routekit-envelope"
      ? { mode: "relay" }
      : destinationWireShape === "openai-responses"
        ? { mode: "forward", owner: reasoningOwner, unwrap: false }
        : { mode: "drop" };
  const prepared = prepareResponsesReasoningInput(includeCompatibleBody, reasoningPolicy);
  recordDroppedEncryptedReasoning(prepared.dropped);
  const translatedBody = prepared.body;
  let chat: Record<string, unknown>;
  try {
    chat = responsesToChat(translatedBody, upstreamModel, { serverTools, destinationWireShape });
  } catch (error) {
    if (!(error instanceof ResponsesTranslationError)) throw error;
    return jsonResponse(400, {
      error: {
        type: "invalid_request_error",
        code: error.code,
        param: "input",
        message: error.message
      }
    });
  }
  const requestOptions = {
    ...backendOptions,
    modelCallId,
    // The streamed response is translated to Responses SSE by
    // openAiSseToResponses, which emits its own keepalive.
    ...(body.stream === true ? { translated: true } : {})
  };
  const upstream = await backend.chat(chat, signal, requestOptions);

  if (!upstream.ok) {
    const detail = await upstream.text();
    return jsonResponse(upstream.status, { error: unwrapUpstreamError(detail) });
  }

  if (executor !== undefined) {
    const loopOptions = {
      chat,
      runStep: (stepChat: Record<string, unknown>) =>
        backend.chat(stepChat, signal, requestOptions),
      serverToolNames: new Set([WEB_SEARCH_TOOL_NAME]),
      executor,
      ...(signal !== undefined ? { signal } : {})
    };
    if (body.stream === true) {
      const source = upstream.body;
      if (source === null)
        return jsonResponse(502, { error: { type: "api_error", message: "no upstream stream" } });
      const composed = composeServerToolStream({ ...loopOptions, firstStep: upstream });
      return new Response(openAiSseToResponses(composed, requestedModel, toolRegistry), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      });
    }
    const outcome = await runBufferedServerToolLoop({ ...loopOptions, firstStep: upstream });
    if (outcome.kind === "upstream_error") {
      const detail = await outcome.response.text();
      return jsonResponse(outcome.response.status, {
        error: { type: "api_error", message: detail.slice(0, 2000) }
      });
    }
    return jsonResponse(
      200,
      chatToResponses(outcome.openai, requestedModel, toolRegistry, outcome.searches)
    );
  }

  if (body.stream === true) {
    const source = upstream.body;
    if (source === null)
      return jsonResponse(502, { error: { type: "api_error", message: "no upstream stream" } });
    return new Response(openAiSseToResponses(source, requestedModel, toolRegistry), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }

  const openai = decodeOpenAiChatResponse(await upstream.json());
  return jsonResponse(200, chatToResponses(openai, requestedModel, toolRegistry));
}
