/**
 * Anthropic Messages provider backend. Sends chat through `/v1/messages`.
 * OpenAI Chat Completions JSON ↔ Anthropic Messages translation lives in
 * `anthropic-provider-codec.ts`.
 */

import { routeKitRequestValidationErrorOf } from "./adapters/openai-chat-wire.js";
import {
  anthropicMessages,
  anthropicSseToChatChunks,
  anthropicThinkingValidationError,
  fromAnthropicMessage
} from "./anthropic-provider-codec.js";
import type { BackendRequestOptions } from "./backend.js";
import { joinPath } from "./backend.js";
import { copyFailure, jsonResponse } from "./http-response.js";
import {
  bodyRecord,
  type ChatBody,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  runProviderTransport
} from "./provider-backend-core.js";
import { decodeAnthropicSseEvent, decodeProviderJson } from "./provider-protocol.js";

export class AnthropicBackend extends HttpProviderBackend {
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): Promise<Response> {
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Promise.resolve(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    return this.#chat(bodyRecord(body), signal, options);
  }

  async #chat(
    body: ChatBody,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const model = body.model ?? this.defaultModel ?? "";
    const thinkingError = anthropicThinkingValidationError(body);
    if (thinkingError !== undefined) {
      return jsonResponse(
        { error: { type: "invalid_request_error", message: thinkingError } },
        400
      );
    }
    const response = await runProviderTransport(
      this.transport,
      joinPath(this.baseUrl, "/messages"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          ...this.extraHeaders
        },
        body: JSON.stringify(anthropicMessages(body, model)),
        ...(signal !== undefined ? { signal } : {})
      },
      options,
      this.platform
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const blockTypes = new Map<number, string>();
      return mapSse(
        response,
        (event, item) => anthropicSseToChatChunks(event, item, model, blockTypes),
        (data, event) => decodeAnthropicSseEvent(data, event)
      );
    }
    const payload = decodeProviderJson("anthropic", "message response", await response.json());
    return jsonResponse(fromAnthropicMessage(payload, model), 200, response.headers);
  }
}
