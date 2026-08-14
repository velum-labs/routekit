/**
 * Google Generative Language provider backend. Sends chat through Gemini
 * generateContent / streamGenerateContent. OpenAI Chat Completions JSON ↔
 * generateContent translation lives in `google-codec.ts`.
 */

import { routeKitRequestValidationErrorOf } from "./adapters/openai-chat-wire.js";
import type { BackendRequestOptions } from "./backend.js";
import { joinPath } from "./backend.js";
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
  runProviderTransport
} from "./provider-backend-core.js";
import { decodeGoogleGenerateContent } from "./provider-protocol.js";

export class GoogleGenAiBackend extends HttpProviderBackend {
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
    const method = body.stream === true ? "streamGenerateContent" : "generateContent";
    const response = await runProviderTransport(
      this.transport,
      `${joinPath(this.baseUrl, `/models/${encodeURIComponent(model)}:${method}`)}${
        body.stream === true ? "?alt=sse" : ""
      }`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
          ...this.extraHeaders
        },
        body: JSON.stringify(googleRequest(body)),
        ...(signal !== undefined ? { signal } : {})
      },
      options,
      this.platform
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const streamState = createGoogleStreamPartState();
      return mapSse(
        response,
        (_event, payload) => [googleChatChunk(payload, model, streamState)],
        (data) => decodeGoogleGenerateContent(data)
      );
    }
    const payload = decodeGoogleGenerateContent(await response.json());
    return jsonResponse(chatCompletion(model, googleMessage(payload), googleUsage(payload)));
  }
}
