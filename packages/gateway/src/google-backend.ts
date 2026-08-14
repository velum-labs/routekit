/**
 * Google Generative Language provider backend. Sends chat through Gemini
 * generateContent / streamGenerateContent. OpenAI Chat Completions JSON ↔
 * generateContent translation lives in `google-codec.ts`.
 */

import { Effect } from "effect";
import { routeKitRequestValidationErrorOf } from "./adapters/openai-chat-wire.js";
import type { BackendRequest, BackendRequestOptions } from "./backend.js";
import { joinPath } from "./backend.js";
import { gatewayTry, gatewayTryPromise } from "./effect/gateway.js";
import {
  createGoogleStreamPartState,
  googleChatChunk,
  googleMessage,
  googleRequest,
  googleUsage
} from "./google-codec.js";
import { copyFailure, jsonResponse } from "./http-response.js";
import {
  bodyRecord,
  type ChatBody,
  chatCompletion,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  providerTransport
} from "./provider-backend-core.js";
import { decodeGoogleGenerateContent } from "./provider-protocol.js";

export class GoogleGenAiBackend extends HttpProviderBackend {
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
      const method = body.stream === true ? "streamGenerateContent" : "generateContent";
      const response = yield* providerTransport(
        self.transport,
        `${joinPath(self.baseUrl, `/models/${encodeURIComponent(model)}:${method}`)}${
          body.stream === true ? "?alt=sse" : ""
        }`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": self.apiKey,
            ...self.extraHeaders
          },
          body: JSON.stringify(googleRequest(body)),
          ...(signal !== undefined ? { signal } : {})
        },
        options,
        self.platform
      );
      if (!response.ok)
        return copyFailure(response, yield* gatewayTryPromise(() => response.text()));
      if (body.stream === true) {
        const streamState = createGoogleStreamPartState();
        return mapSse(
          response,
          (_event, payload) => [googleChatChunk(payload, model, streamState)],
          (data) => decodeGoogleGenerateContent(data)
        );
      }
      const json = yield* gatewayTryPromise(() => response.json());
      const payload = yield* gatewayTry(() => decodeGoogleGenerateContent(json));
      return jsonResponse(chatCompletion(model, googleMessage(payload), googleUsage(payload)));
    });
  }
}
