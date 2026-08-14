/**
 * Anthropic Messages provider backend. Sends chat through `/v1/messages`.
 * OpenAI Chat Completions JSON ↔ Anthropic Messages translation lives in
 * `anthropic-provider-codec.ts`.
 */

import { Effect } from "effect";
import { routeKitRequestValidationErrorOf } from "./adapters/openai-chat-wire.js";
import type { BackendRequest, BackendRequestOptions } from "./backend.js";
import { joinPath } from "./backend.js";
import { gatewayTry, gatewayTryPromise } from "./effect/gateway.js";
import { copyFailure, jsonResponse } from "./http-response.js";
import {
  bodyRecord,
  type ChatBody,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  providerTransport
} from "./provider-backend-core.js";
import { decodeAnthropicSseEvent, decodeProviderJson } from "./provider-protocol.js";
import {
  anthropicMessages,
  anthropicSseToChatChunks,
  anthropicThinkingValidationError,
  fromAnthropicMessage
} from "./anthropic-provider-codec.js";

export class AnthropicBackend extends HttpProviderBackend {
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const validationError = routeKitRequestValidationErrorOf(body);
    if (validationError !== undefined) {
      return Effect.succeed(
        invalidReasoningControlResponse(
          validationError.message,
          validationError.code === "invalid_reasoning_metadata",
          validationError.path
        )
      );
    }
    return this.#chat(bodyRecord(body), signal, options);
  }

  #chat(body: ChatBody, signal?: AbortSignal, options?: BackendRequestOptions): BackendRequest {
    const self = this;
    return Effect.gen(function* () {
      const model = body.model ?? self.defaultModel ?? "";
      const thinkingError = anthropicThinkingValidationError(body);
      if (thinkingError !== undefined) {
        return jsonResponse(
          { error: { type: "invalid_request_error", message: thinkingError } },
          400
        );
      }
      const response = yield* providerTransport(
        self.transport,
        joinPath(self.baseUrl, "/messages"),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": self.apiKey,
            "anthropic-version": "2023-06-01",
            ...self.extraHeaders
          },
          body: JSON.stringify(anthropicMessages(body, model)),
          ...(signal !== undefined ? { signal } : {})
        },
        options,
        self.platform
      );
      if (!response.ok)
        return copyFailure(response, yield* gatewayTryPromise(() => response.text()));
      if (body.stream === true) {
        const blockTypes = new Map<number, string>();
        return mapSse(
          response,
          (event, item) => anthropicSseToChatChunks(event, item, model, blockTypes),
          (data, event) => decodeAnthropicSseEvent(data, event)
        );
      }
      const json = yield* gatewayTryPromise(() => response.json());
      const payload = yield* gatewayTry(() =>
        decodeProviderJson("anthropic", "message response", json)
      );
      return jsonResponse(fromAnthropicMessage(payload, model), 200, response.headers);
    });
  }
}
