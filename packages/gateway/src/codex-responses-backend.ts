/**
 * Codex Responses provider backend. Sends chat through `/v1/responses`.
 * OpenAI Chat Completions JSON ↔ Responses translation lives in
 * `codex-responses-codec.ts`.
 */

import { StreamPump } from "@velum-labs/routekit-runtime/sse";
import { routeKitRequestValidationErrorOf } from "./adapters/openai-chat-wire.js";
import type { BackendRequestOptions } from "./backend.js";
import { joinPath } from "./backend.js";
import {
  applyCodexForceStreamEvent,
  codexCompletionResponse,
  codexForceStreamResponse,
  codexReasoningModeError,
  codexSseToChatChunks,
  createCodexForceStreamState,
  createCodexStreamState,
  responsesRequest
} from "./codex-responses-codec.js";
import { copyFailure, jsonResponse } from "./http-response.js";
import {
  bodyRecord,
  type ChatBody,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  type ProviderBackendOptions,
  runProviderTransport
} from "./provider-backend-core.js";
import { decodeOpenAiResponsesEvent, decodeProviderJson } from "./provider-protocol.js";
import { SseParseError } from "./sse/parse.js";

export class CodexResponsesBackend extends HttpProviderBackend {
  readonly #accountId: string | undefined;
  readonly #forceStream: boolean;
  readonly #omitSampling: boolean;

  constructor(options: ProviderBackendOptions & { accountId?: string }) {
    super(options);
    this.#accountId = options.accountId;
    this.#forceStream = options.forceStream ?? false;
    this.#omitSampling = options.omitSampling ?? false;
  }

  override reasoningWireShape(): string {
    return "openai-responses";
  }

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
    const reasoningError = codexReasoningModeError(body);
    if (reasoningError !== undefined) {
      return jsonResponse(
        {
          error: {
            type: "invalid_request_error",
            message: reasoningError
          }
        },
        400
      );
    }
    const response = await runProviderTransport(
      this.transport,
      joinPath(this.baseUrl, "/responses"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(this.#accountId !== undefined ? { "chatgpt-account-id": this.#accountId } : {}),
          ...this.extraHeaders
        },
        body: JSON.stringify(
          responsesRequest(body, model, {
            forceStream: this.#forceStream,
            omitSampling: this.#omitSampling
          })
        ),
        ...(signal !== undefined ? { signal } : {})
      },
      options
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const streamState = createCodexStreamState();
      return mapSse(
        response,
        (event, item) => codexSseToChatChunks(event, item, model, streamState),
        (data, event) => decodeOpenAiResponsesEvent(data, event)
      );
    }
    if (this.#forceStream) {
      const forceState = createCodexForceStreamState();
      if (response.body === null) {
        throw new SseParseError("provider SSE response had no body");
      }
      await StreamPump.bytes(
        StreamPump.sse(response.body, {
          onEvent(event) {
            let payload: unknown;
            try {
              payload = JSON.parse(event.data);
            } catch {
              if (
                event.event !== "response.output_item.done" &&
                event.event !== "response.completed"
              ) {
                return;
              }
              throw new SseParseError(
                "provider SSE event contained malformed JSON",
                event.data.slice(0, 200)
              );
            }
            const record = decodeOpenAiResponsesEvent(payload, event.event);
            applyCodexForceStreamEvent(event.event ?? record.type, record, forceState);
          },
          onEnd() {}
        }),
        {
          onChunk() {
            // The SSE pump owns decoding; this sink only drives it to completion.
          }
        }
      );
      const completed = codexForceStreamResponse(model, forceState);
      if (completed !== undefined) return completed;
      throw new SseParseError("provider SSE stream ended without response.completed");
    }
    const payload = decodeProviderJson("openai-responses", "response", await response.json());
    return codexCompletionResponse(model, payload);
  }
}
