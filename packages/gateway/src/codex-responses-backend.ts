import { randomId } from "@velum-labs/routekit-runtime";
import { StreamPump } from "@velum-labs/routekit-runtime/sse";
import { droppedField } from "./adapters/dropped.js";
import {
  attachResponsesReasoningMetadata,
  reasoningSelectionOf,
  responsesReasoningItem,
  responsesReasoningMetadataOf,
  routeKitRequestValidationErrorOf
} from "./adapters/openai-chat-wire.js";
import {
  normalizeOpenAiResponsesCallIds,
  prepareResponsesReasoningInput,
  type ResponsesReasoningOwner,
  wrapResponsesEncryptedContent
} from "./adapters/openai-responses-wire.js";
import type { BackendRequestOptions } from "./backend.js";
import { joinPath } from "./backend.js";
import { copyFailure, jsonResponse } from "./http-response.js";
import {
  bodyRecord,
  type ChatBody,
  chatCompletion,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  normalizedOpenAiUsage,
  type ProviderBackendOptions,
  textContent
} from "./provider-backend-core.js";
import {
  decodeOpenAiResponsesEvent,
  decodeProviderJson,
  isProviderRecord,
  ProviderProtocolError
} from "./provider-protocol.js";
import { SseParseError } from "./sse/parse.js";

function responsesRequest(
  body: ChatBody,
  model: string,
  options: { forceStream: boolean; omitSampling: boolean }
): Record<string, unknown> {
  const reasoning = reasoningSelectionOf(body);
  const input = (body.messages ?? []).flatMap((message): Record<string, unknown>[] => {
    if (message.role === "tool") {
      return [
        {
          type: "function_call_output",
          call_id: message.tool_call_id ?? "",
          output: textContent(message.content)
        }
      ];
    }
    const items: Record<string, unknown>[] = [];
    const reasoningMetadata = responsesReasoningMetadataOf(message);
    for (const reasoning of reasoningMetadata?.items ?? []) {
      const item = responsesReasoningItem(reasoning);
      if (item !== undefined) items.push(item);
    }
    const text = textContent(message.content);
    if (text.length > 0) {
      items.push({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text
          }
        ]
      });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id ?? randomId(12, "call_"),
        name: call.function?.name ?? "tool",
        arguments: call.function?.arguments ?? "{}"
      });
    }
    return items;
  });
  const includeEncryptedContent =
    responsesReasoningMetadataOf(body)?.includeEncryptedContent === true ||
    (body.messages ?? []).some(
      (message) => responsesReasoningMetadataOf(message)?.includeEncryptedContent === true
    );
  const request = normalizeOpenAiResponsesCallIds({
    model,
    input,
    stream: options.forceStream || body.stream === true,
    store: false,
    ...(includeEncryptedContent ? { include: ["reasoning.encrypted_content"] } : {}),
    ...(reasoning.mode === "effort" ? { reasoning: { effort: reasoning.effort } } : {}),
    ...(!options.omitSampling && body.max_tokens !== undefined
      ? { max_output_tokens: body.max_tokens }
      : {}),
    ...(!options.omitSampling && body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.tools !== undefined
      ? {
          tools: body.tools.flatMap((tool) =>
            tool.function === undefined
              ? []
              : [
                  {
                    type: "function",
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters ?? { type: "object" }
                  }
                ]
          )
        }
      : {})
  });
  const prepared = prepareResponsesReasoningInput(request, {
    mode: "forward",
    owner: codexReasoningOwner(model)
  });
  if (prepared.dropped > 0) {
    droppedField("responses", "encrypted_content", "input.reasoning");
  }
  return prepared.body as Record<string, unknown>;
}

function codexReasoningOwner(model: string): ResponsesReasoningOwner {
  return { provider: "codex", nativeModel: model };
}

function responsesOutput(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const output = providerRecords(payload.output, "response output");
  const reasoning = output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => {
      const summary = providerRecords(item.summary, "reasoning summary");
      return summary.flatMap((part) => (typeof part.text === "string" ? [part.text] : []));
    })
    .join("");
  const text = output
    .flatMap((item) => {
      const content = providerRecords(item.content, "message content");
      return content.flatMap((part) => (typeof part.text === "string" ? [part.text] : []));
    })
    .join("");
  const reasoningItems = output.flatMap((item) =>
    item.type === "reasoning" &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0
      ? [
          {
            ...item,
            encrypted_content: wrapResponsesEncryptedContent(
              item.encrypted_content,
              codexReasoningOwner(model)
            )
          }
        ]
      : []
  );
  const toolCalls = output.flatMap((item, index) =>
    item.type === "function_call"
      ? [
          {
            id: item.call_id ?? item.id,
            type: "function",
            index,
            function: { name: item.name, arguments: item.arguments ?? "{}" }
          }
        ]
      : []
  );
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
  if (reasoningItems.length > 0) {
    attachResponsesReasoningMetadata(message, {
      items: reasoningItems,
      includeEncryptedContent: false
    });
  }
  return message;
}

const CODEX_EMPTY_RESPONSE_ERROR = {
  message: "Codex completed without assistant content or tool calls",
  type: "upstream_empty_response"
} as const;

function responsesItemText(item: Record<string, unknown>): string {
  if (item.type !== "message") return "";
  return providerRecords(item.content, "message content")
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
    .join("");
}

function providerRecords(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderProtocolError(
      "openai-responses",
      "response",
      `"${field}" must be an array`,
      value
    );
  }
  return value.map((entry) => {
    if (!isProviderRecord(entry)) {
      throw new ProviderProtocolError(
        "openai-responses",
        "response",
        `"${field}" entries must be objects`,
        entry
      );
    }
    return { ...entry };
  });
}

function codexCompletionResponse(model: string, payload: Record<string, unknown>): Response {
  const message = responsesOutput(payload, model);
  const hasOutput =
    (typeof message.content === "string" && message.content.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  return hasOutput
    ? jsonResponse(chatCompletion(model, message, normalizedOpenAiUsage(payload.usage)))
    : jsonResponse({ error: CODEX_EMPTY_RESPONSE_ERROR }, 502);
}

function codexTerminalError(payload: unknown): Record<string, unknown> {
  const record = isProviderRecord(payload) ? payload : {};
  const response = isProviderRecord(record.response) ? record.response : undefined;
  const raw = isProviderRecord(record.error)
    ? record.error
    : isProviderRecord(response?.error)
      ? response.error
      : undefined;
  const details = isProviderRecord(response?.incomplete_details)
    ? response.incomplete_details
    : undefined;
  return {
    ...(raw ?? {}),
    type: raw?.type ?? raw?.error_type ?? details?.reason ?? "upstream_error",
    message: typeof raw?.message === "string" ? raw.message : "Codex response did not complete"
  };
}

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
    const reasoning = reasoningSelectionOf(body);
    if (reasoning.mode === "budget" || reasoning.mode === "adaptive") {
      return jsonResponse(
        {
          error: {
            type: "invalid_request_error",
            message: `Codex Responses cannot represent reasoning mode "${reasoning.mode}"`
          }
        },
        400
      );
    }
    const response = await this.transport(
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
      let hasToolCalls = false;
      let hasAssistantContent = false;
      const emittedText = new Map<number, string>();
      const contentChunk = (content: string): Record<string, unknown> => ({
        id: randomId(18, "chatcmpl_"),
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }]
      });
      const recoverMessage = (
        output: Record<string, unknown>,
        outputIndex: number
      ): Record<string, unknown>[] => {
        const complete = responsesItemText(output);
        const previous = emittedText.get(outputIndex) ?? "";
        const suffix = complete.startsWith(previous) ? complete.slice(previous.length) : "";
        if (suffix.length === 0) return [];
        emittedText.set(outputIndex, complete);
        hasAssistantContent = true;
        return [contentChunk(suffix)];
      };
      return mapSse(
        response,
        (event, item) => {
          const eventType =
            event === "message" && typeof item.type === "string" ? item.type : event;
          if (
            eventType === "response.reasoning_summary_text.delta" ||
            eventType === "response.reasoning_text.delta"
          ) {
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning: item.delta },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
          if (eventType === "response.output_text.delta") {
            const outputIndex = typeof item.output_index === "number" ? item.output_index : 0;
            const delta = typeof item.delta === "string" ? item.delta : "";
            emittedText.set(outputIndex, `${emittedText.get(outputIndex) ?? ""}${delta}`);
            if (delta.length === 0) return [];
            hasAssistantContent = true;
            return [contentChunk(delta)];
          }
          if (eventType === "response.function_call_arguments.delta") {
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: item.output_index ?? 0,
                          function: { arguments: item.delta }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
          if (eventType === "response.output_item.added") {
            const output = isProviderRecord(item.item) ? item.item : undefined;
            if (output?.type !== "function_call") return [];
            hasToolCalls = true;
            return [
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: item.output_index ?? 0,
                          id: output.call_id ?? output.id,
                          type: "function",
                          function: { name: output.name, arguments: "" }
                        }
                      ]
                    },
                    finish_reason: null
                  }
                ]
              }
            ];
          }
          if (eventType === "response.output_item.done") {
            const output = isProviderRecord(item.item) ? item.item : undefined;
            if (
              output?.type === "reasoning" &&
              typeof output.encrypted_content === "string" &&
              output.encrypted_content.length > 0
            ) {
              const delta: Record<string, unknown> = {};
              const wrappedOutput = {
                ...output,
                encrypted_content: wrapResponsesEncryptedContent(
                  output.encrypted_content,
                  codexReasoningOwner(model)
                )
              };
              attachResponsesReasoningMetadata(delta, {
                items: [wrappedOutput],
                includeEncryptedContent: false
              });
              return [
                {
                  id: randomId(18, "chatcmpl_"),
                  object: "chat.completion.chunk",
                  model,
                  choices: [{ index: 0, delta, finish_reason: null }]
                }
              ];
            }
            if (output?.type !== "message") return [];
            const outputIndex = typeof item.output_index === "number" ? item.output_index : 0;
            return recoverMessage(output, outputIndex);
          }
          if (eventType === "response.completed") {
            const completed = isProviderRecord(item.response) ? item.response : undefined;
            const recovered = Array.isArray(completed?.output)
              ? completed.output.flatMap((output, outputIndex) =>
                  isProviderRecord(output) && output.type === "message"
                    ? recoverMessage(output, outputIndex)
                    : []
                )
              : [];
            if (!hasAssistantContent && !hasToolCalls) {
              return [...recovered, { error: CODEX_EMPTY_RESPONSE_ERROR }];
            }
            return [
              ...recovered,
              {
                id: randomId(18, "chatcmpl_"),
                object: "chat.completion.chunk",
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: hasToolCalls ? "tool_calls" : "stop"
                  }
                ],
                ...(completed?.usage !== undefined
                  ? { usage: normalizedOpenAiUsage(completed.usage) }
                  : {})
              }
            ];
          }
          if (
            eventType === "response.failed" ||
            eventType === "response.incomplete" ||
            eventType === "error"
          ) {
            return [{ error: codexTerminalError(item) }];
          }
          return [];
        },
        (data, event) => decodeOpenAiResponsesEvent(data, event)
      );
    }
    if (this.#forceStream) {
      const completedOutput = new Map<number, Record<string, unknown>>();
      let completedResponse: Record<string, unknown> | undefined;
      let terminalFailure: Record<string, unknown> | undefined;
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
            const eventType = event.event ?? record.type;
            if (eventType === "response.output_item.done" && isProviderRecord(record.item)) {
              const outputIndex =
                typeof record.output_index === "number"
                  ? record.output_index
                  : completedOutput.size;
              completedOutput.set(outputIndex, { ...record.item });
            }
            if (eventType === "response.completed" && isProviderRecord(record.response)) {
              completedResponse = { ...record.response };
            }
            if (
              eventType === "response.failed" ||
              eventType === "response.incomplete" ||
              eventType === "error"
            ) {
              terminalFailure = codexTerminalError(record);
            }
          },
          onEnd() {}
        }),
        {
          onChunk() {
            // The SSE pump owns decoding; this sink only drives it to completion.
          }
        }
      );
      if (completedResponse !== undefined) {
        const terminalOutput = Array.isArray(completedResponse.output)
          ? [...completedResponse.output]
          : [];
        for (const [outputIndex, output] of completedOutput) {
          if (terminalOutput[outputIndex] === undefined) {
            terminalOutput[outputIndex] = output;
          }
        }
        const payload = { ...completedResponse, output: terminalOutput };
        return codexCompletionResponse(model, payload);
      }
      if (terminalFailure !== undefined) return jsonResponse({ error: terminalFailure }, 502);
      throw new SseParseError("provider SSE stream ended without response.completed");
    }
    const payload = decodeProviderJson("openai-responses", "response", await response.json());
    return codexCompletionResponse(model, payload);
  }
}
