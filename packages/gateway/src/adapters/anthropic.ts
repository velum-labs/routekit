/**
 * Anthropic Messages adapter. Claude Code speaks the Anthropic Messages API to
 * whatever `ANTHROPIC_BASE_URL` points at, so to back it with a local model we
 * translate `/v1/messages` (and `/v1/messages/count_tokens`, and the
 * `/v1/models` discovery probe) to and from the gateway's OpenAI Chat
 * Completions core.
 *
 * Layers:
 * - `anthropic-wire.ts` — request types
 * - `anthropic-codec.ts` — JSON request/response translation
 * - `anthropic-stream.ts` — SSE translation
 * - `anthropic-models.ts` — Claude picker and `/v1/models`
 * - this module — HTTP handlers that wire the codec to a `Backend`
 */

import { Effect } from "effect";
import type { Backend, BackendRequest, BackendRequestOptions } from "../backend.js";
import { gatewayTry, gatewayTryPromise, runBackendRequest } from "../effect/gateway.js";
import { jsonResponse } from "../http-response.js";
import { decodeOpenAiChatResponse } from "../provider-protocol.js";
import {
  anthropicToChat,
  chatToAnthropicMessage,
  countTokensEstimate,
  isAnthropicServerTool,
  isAnthropicWebSearchTool,
  thinkingValidationError,
  WEB_SEARCH_TOOL_NAME
} from "./anthropic-codec.js";
import { openAiSseToAnthropic } from "./anthropic-stream.js";
import type { AnthropicRequest } from "./anthropic-wire.js";
import { composeServerToolStream, runBufferedServerToolLoop } from "./server-tool-loop.js";
import { unwrapUpstreamError } from "./upstream-error.js";
import { resolveWebSearchExecutor } from "./web-search.js";

export type { AnthropicTranslationOptions } from "./anthropic-codec.js";
export {
  anthropicToChat,
  chatToAnthropicMessage,
  countTokensEstimate,
  mapStopReason
} from "./anthropic-codec.js";
export type { ClaudeModelSelection, ClaudePickerModelRoute } from "./anthropic-models.js";
export {
  anthropicModelsResponse,
  CLAUDE_ALIAS_PREFIX,
  CLAUDE_PICKER_PREFIX,
  claudePickerClientModel,
  resolveClaudeModelAlias,
  resolveClaudeModelSelection,
  withClaudeReasoningSelection
} from "./anthropic-models.js";
export { openAiSseToAnthropic } from "./anthropic-stream.js";
export type { AnthropicRequest } from "./anthropic-wire.js";

// ---- handlers (return a Response the server pipes) ----

export function handleAnthropicMessages(
  backend: Backend,
  body: AnthropicRequest,
  modelCallId?: string,
  signal?: AbortSignal,
  backendOptions: BackendRequestOptions = {}
): BackendRequest {
  return Effect.gen(function* () {
    const invalidThinking = thinkingValidationError(body);
    if (invalidThinking !== undefined) {
      return jsonResponse(400, {
        type: "error",
        error: { type: "invalid_request_error", message: invalidThinking }
      });
    }
    const requestedModel = body.model ?? backend.defaultModel ?? "";
    const resolvedModel = backend.ports.models.resolve(body.model);
    if (
      body.model !== undefined &&
      backend.ports.models.kind === "model-catalog" &&
      resolvedModel === undefined
    ) {
      return jsonResponse(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `unknown model: ${body.model}`
        }
      });
    }
    const upstreamModel = resolvedModel ?? backend.defaultModel;
    if (upstreamModel === undefined) {
      return jsonResponse(503, {
        type: "error",
        error: {
          type: "unavailable",
          message: "no model is available; configure a provider"
        }
      });
    }
    // Server-executed web search is honored when the caller declared the server
    // tool, an executor is available, and no *client* tool already owns the
    // projected name (a client `web_search` must keep round-tripping untouched).
    const declaresWebSearch = body.tools?.some(isAnthropicWebSearchTool) === true;
    const clientNameCollision =
      body.tools?.some(
        (tool) => !isAnthropicServerTool(tool) && tool.name === WEB_SEARCH_TOOL_NAME
      ) === true;
    const executor =
      declaresWebSearch && !clientNameCollision ? resolveWebSearchExecutor("anthropic") : undefined;
    const serverTools = executor !== undefined;
    const chat = anthropicToChat(body, upstreamModel, { serverTools });
    const requestOptions = {
      ...backendOptions,
      modelCallId,
      // The streamed response is translated to Anthropic SSE by
      // openAiSseToAnthropic, which emits its own `ping` keepalive.
      ...(body.stream === true ? { translated: true } : {})
    };
    const upstream = yield* backend.chat(chat, signal, requestOptions);

    if (!upstream.ok) {
      const detail = yield* gatewayTryPromise(() => upstream.text());
      return jsonResponse(upstream.status, { type: "error", error: unwrapUpstreamError(detail) });
    }

    if (executor !== undefined) {
      const loopOptions = {
        chat,
        runStep: (stepChat: Record<string, unknown>) =>
          runBackendRequest(
            backendOptions.platform,
            backend.chat(stepChat, signal, requestOptions)
          ),
        serverToolNames: new Set([WEB_SEARCH_TOOL_NAME]),
        executor,
        ...(signal !== undefined ? { signal } : {}),
        ...(backendOptions.platform !== undefined ? { platform: backendOptions.platform } : {})
      };
      if (body.stream === true) {
        const source = upstream.body;
        if (source === null)
          return jsonResponse(502, {
            type: "error",
            error: { type: "api_error", message: "no upstream stream" }
          });
        const composed = composeServerToolStream({ ...loopOptions, firstStep: upstream });
        return new Response(openAiSseToAnthropic(composed, requestedModel), {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
        });
      }
      const outcome = yield* gatewayTryPromise(() =>
        runBufferedServerToolLoop({ ...loopOptions, firstStep: upstream })
      );
      if (outcome.kind === "upstream_error") {
        const detail = yield* gatewayTryPromise(() => outcome.response.text());
        return jsonResponse(outcome.response.status, {
          type: "error",
          error: { type: "api_error", message: detail.slice(0, 2000) }
        });
      }
      return jsonResponse(
        200,
        chatToAnthropicMessage(outcome.openai, requestedModel, outcome.searches, outcome.events)
      );
    }

    if (body.stream === true) {
      const source = upstream.body;
      if (source === null)
        return jsonResponse(502, {
          type: "error",
          error: { type: "api_error", message: "no upstream stream" }
        });
      return new Response(openAiSseToAnthropic(source, requestedModel), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      });
    }

    const payload = yield* gatewayTryPromise(() => upstream.json());
    const openai = yield* gatewayTry(() => decodeOpenAiChatResponse(payload));
    return jsonResponse(200, chatToAnthropicMessage(openai, requestedModel));
  });
}

export function handleCountTokens(body: AnthropicRequest): Response {
  return jsonResponse(200, { input_tokens: countTokensEstimate(body) });
}
