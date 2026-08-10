import { randomId } from "@velum-labs/routekit-runtime";
import { copyFailure, jsonResponse } from "./http-response.js";

import { joinPath } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
export { AnthropicBackend } from "./anthropic-backend.js";
import {
  bodyRecord,
  chatCompletion,
  HttpProviderBackend,
  invalidReasoningControlResponse,
  mapSse,
  normalizedOpenAiUsage,
  textContent,
  type ChatBody,
  type ChatMessage,
  type ProviderBackendOptions,
  type ProviderTransport
} from "./provider-backend-core.js";
export type { ProviderBackendOptions, ProviderTransport } from "./provider-backend-core.js";
import { droppedField } from "./adapters/dropped.js";
import {
  normalizeOpenAiResponsesCallIds,
  prepareResponsesReasoningInput,
  wrapResponsesEncryptedContent,
  type ResponsesReasoningOwner
} from "./adapters/openai-responses-wire.js";
import { SseDecoder, SseParseError } from "./sse/parse.js";
import {
  anthropicMessageContentOf,
  anthropicReasoningDetailsOf,
  anthropicRequestMetadataOf,
  attachGoogleToolCallIndexes,
  googleThoughtDetailsOf,
  googleToolCallIndexesOf,
  reasoningSelectionOf,
  routeKitRequestValidationErrorOf,
  attachResponsesReasoningMetadata,
  responsesReasoningMetadataOf,
  type ResponsesReasoningItem,
  type AnthropicNativeContentBlock,
  type AnthropicReasoningDetail,
  type CanonicalReasoningDetail,
  type AnthropicRequestMetadata
} from "./adapters/openai-chat-wire.js";

function googleThoughtDetail(
  part: Record<string, unknown>,
  index: number
): CanonicalReasoningDetail | undefined {
  if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length === 0) {
    return undefined;
  }
  return {
    type: "google_thought",
    index,
    ...(part.thought === true && typeof part.text === "string"
      ? { thought: part.text }
      : {}),
    thoughtSignature: part.thoughtSignature
  };
}

function googleAssistantParts(message: ChatMessage): Array<Record<string, unknown>> {
  const details = googleThoughtDetailsOf(message.reasoning_details);
  const detailsByIndex = new Map(details.map((detail) => [detail.index, detail]));
  const privateIndexes = googleToolCallIndexesOf(message);
  const callsByIndex = new Map(
    (message.tool_calls ?? []).flatMap((call, fallbackIndex) => {
      const index =
        typeof call.id === "string" && Number.isInteger(privateIndexes[call.id])
          ? (privateIndexes[call.id] as number)
          : Number.isInteger((call as { index?: unknown }).index)
            ? ((call as { index: number }).index)
            : fallbackIndex;
      return [[index, call] as const];
    })
  );
  if (details.length === 0) {
    const parts: Array<Record<string, unknown>> = [];
    const text = textContent(message.content);
    if (text.length > 0) parts.push({ text });
    for (const call of message.tool_calls ?? []) parts.push(googleFunctionCallPart(call));
    return parts;
  }

  const parts: Array<Record<string, unknown>> = [];
  const text = textContent(message.content);
  let textAdded = false;
  const addText = (): void => {
    if (!textAdded && text.length > 0) parts.push({ text });
    textAdded = true;
  };
  const consumedCalls = new Set<NonNullable<ChatMessage["tool_calls"]>[number]>();
  for (const index of [...new Set([...detailsByIndex.keys(), ...callsByIndex.keys()])].sort((a, b) => a - b)) {
    const detail = detailsByIndex.get(index);
    const call = callsByIndex.get(index);
    if (typeof detail?.thought === "string") {
      parts.push({ text: detail.thought, thought: true, thoughtSignature: detail.thoughtSignature });
    } else if (call !== undefined) {
      addText();
      parts.push({
        ...googleFunctionCallPart(call),
        ...(detail !== undefined ? { thoughtSignature: detail.thoughtSignature } : {})
      });
      consumedCalls.add(call);
    }
  }
  addText();
  for (const call of message.tool_calls ?? []) {
    if (!consumedCalls.has(call)) parts.push(googleFunctionCallPart(call));
  }
  return parts;
}

function googleFunctionCallPart(
  call: NonNullable<ChatMessage["tool_calls"]>[number]
): Record<string, unknown> {
  let args: unknown = {};
  try {
    args = JSON.parse(call.function?.arguments ?? "{}");
  } catch {
    args = { raw: call.function?.arguments ?? "" };
  }
  return { functionCall: { name: call.function?.name ?? "tool", args } };
}

function googleRequest(body: ChatBody): Record<string, unknown> {
  const systemText = (body.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .join("\n\n");
  const toolNames = new Map<string, string>();
  for (const message of body.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      if (call.id !== undefined && call.function?.name !== undefined) {
        toolNames.set(call.id, call.function.name);
      }
    }
  }
  const reasoning = reasoningSelectionOf(body);
  const thinkingConfig =
    reasoning.mode === "effort"
      ? { thinkingLevel: reasoning.effort }
      : reasoning.mode === "budget"
        ? { thinkingBudget: reasoning.budgetTokens }
        : reasoning.mode === "adaptive"
          ? { thinkingBudget: -1 }
          : reasoning.mode === "disabled"
            ? { thinkingBudget: 0 }
            : undefined;
  return {
    contents: (body.messages ?? []).flatMap((message) => {
      if (message.role === "system") return [];
      if (message.role === "tool") {
        return [{ role: "user", parts: [{ functionResponse: {
          name: toolNames.get(message.tool_call_id ?? "") ?? "tool",
          response: { output: textContent(message.content) }
        } }] }];
      }
      const parts = message.role === "assistant"
        ? googleAssistantParts(message)
        : textContent(message.content).length > 0
          ? [{ text: textContent(message.content) }]
          : [];
      return [{ role: message.role === "assistant" ? "model" : "user", parts }];
    }),
    ...(systemText.length > 0
      ? { systemInstruction: { role: "system", parts: [{ text: systemText }] } }
      : {}),
    generationConfig: {
      ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(thinkingConfig !== undefined ? { thinkingConfig } : {})
    },
    ...(body.tools !== undefined ? { tools: [{ functionDeclarations: body.tools.flatMap((tool) =>
      tool.function === undefined ? [] : [{
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      }]) }] } : {})
  };
}

type GoogleStreamToolPart = {
  providerIndex: number;
  toolIndex: number;
  id: string;
};

type GoogleStreamPartState = {
  nextProviderIndex: number;
  nextToolIndex: number;
  openThoughtIndex?: number;
  toolParts: Map<string, GoogleStreamToolPart>;
  thoughtText: Map<number, string>;
};

function googleFunctionIdentity(call: Record<string, unknown>): string | undefined {
  const providerId = call.id ?? call.callId ?? call.functionCallId;
  return typeof providerId === "string" && providerId.length > 0
    ? `id:${providerId}`
    : undefined;
}

function googleMessage(
  payload: Record<string, unknown>,
  streamState?: GoogleStreamPartState
): Record<string, unknown> {
  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts)
    ? (content.parts as Array<Record<string, unknown>>)
    : [];
  let bufferedToolIndex = 0;
  const indexedParts: Array<{
    part: Record<string, unknown>;
    detailPart: Record<string, unknown>;
    providerIndex: number;
    toolIndex?: number;
    id?: string;
  }> = parts.map((part, localIndex) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    if (streamState === undefined) {
      return {
        part,
        detailPart: part,
        providerIndex: localIndex,
        ...(call !== undefined ? { toolIndex: bufferedToolIndex++ } : {})
      };
    }
    if (call !== undefined) {
      streamState.openThoughtIndex = undefined;
      const identity = googleFunctionIdentity(call);
      let toolPart = identity === undefined ? undefined : streamState.toolParts.get(identity);
      if (toolPart === undefined) {
        toolPart = {
          providerIndex: streamState.nextProviderIndex++,
          toolIndex: streamState.nextToolIndex++,
          id: randomId(12, "call_")
        };
        if (identity !== undefined) streamState.toolParts.set(identity, toolPart);
      }
      return { part, detailPart: part, ...toolPart };
    }
    if (part.thought === true) {
      const signature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined;
      let providerIndex = streamState.openThoughtIndex;
      if (providerIndex === undefined) {
        providerIndex = streamState.nextProviderIndex++;
        streamState.openThoughtIndex = providerIndex;
      }
      const priorText = streamState.thoughtText.get(providerIndex) ?? "";
      const incomingText = typeof part.text === "string" ? part.text : "";
      const thought = `${priorText}${incomingText}`;
      streamState.thoughtText.set(providerIndex, thought);
      if (signature !== undefined) streamState.openThoughtIndex = undefined;
      return {
        part,
        detailPart:
          signature !== undefined
            ? { ...part, thought: true, text: thought, thoughtSignature: signature }
            : part,
        providerIndex
      };
    }
    streamState.openThoughtIndex = undefined;
    return { part, detailPart: part, providerIndex: streamState.nextProviderIndex++ };
  });
  const text = indexedParts
    .filter(({ part }) => part.thought === undefined || part.thought === false)
    .map(({ part }) => typeof part.text === "string" ? part.text : "")
    .join("");
  const reasoning = indexedParts
    .filter(({ part }) => part.thought === true)
    .map(({ part }) => typeof part.text === "string" ? part.text : "")
    .join("");
  const reasoningDetails = indexedParts.flatMap(({ detailPart, providerIndex }) => {
    const detail = googleThoughtDetail(detailPart, providerIndex);
    return detail === undefined ? [] : [detail];
  });
  const toolCalls = indexedParts.flatMap(({ part, providerIndex, toolIndex, id }) => {
    const call = part.functionCall as Record<string, unknown> | undefined;
    return call === undefined || toolIndex === undefined ? [] : [{
      id: id ?? randomId(12, "call_"),
      type: "function",
      index: toolIndex,
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      providerIndex
    }];
  });
  const message: Record<PropertyKey, unknown> = {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map(({ providerIndex: _providerIndex, ...call }) => call)
        }
      : {})
  };
  const providerIndexes = Object.fromEntries(
    toolCalls.map((call) => [call.id, call.providerIndex])
  );
  if (Object.keys(providerIndexes).length > 0) {
    attachGoogleToolCallIndexes(message, providerIndexes);
  }
  return message;
}

export class GoogleGenAiBackend extends HttpProviderBackend {
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
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
    const response = await this.transport(
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
      options
    );
    if (!response.ok) return copyFailure(response, await response.text());
    if (body.stream === true) {
      const streamState: GoogleStreamPartState = {
        nextProviderIndex: 0,
        nextToolIndex: 0,
        toolParts: new Map(),
        thoughtText: new Map()
      };
      return mapSse(response, (_event, data) => {
        const payload = data as Record<string, unknown>;
        const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
        const finishReason = candidates?.[0]?.finishReason;
        const usage = payload.usageMetadata as Record<string, unknown> | undefined;
        return [
          {
            id: randomId(18, "chatcmpl_"),
            object: "chat.completion.chunk",
            model,
            choices: [
              {
                index: 0,
                delta: googleMessage(payload, streamState),
                finish_reason:
                  finishReason === undefined
                    ? null
                    : finishReason === "MAX_TOKENS"
                      ? "length"
                      : "stop"
              }
            ],
            ...(usage !== undefined
              ? {
                  usage: {
                    prompt_tokens: usage.promptTokenCount,
                    completion_tokens: usage.candidatesTokenCount,
                    total_tokens: usage.totalTokenCount
                  }
                }
              : {})
          }
        ];
      });
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const usage = payload.usageMetadata as Record<string, unknown> | undefined;
    return jsonResponse(
      chatCompletion(model, googleMessage(payload), {
        prompt_tokens: usage?.promptTokenCount,
        completion_tokens: usage?.candidatesTokenCount,
        total_tokens: usage?.totalTokenCount
      })
    );
  }
}

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
    for (const item of reasoningMetadata?.items ?? []) {
      items.push({
        type: "reasoning",
        ...(item.id !== undefined ? { id: item.id } : {}),
        ...(Object.hasOwn(item, "summary") ? { summary: item.summary } : {}),
        ...(Object.hasOwn(item, "content") ? { content: item.content } : {}),
        encrypted_content: item.encrypted_content
      });
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
    ...(reasoning.mode === "effort"
      ? { reasoning: { effort: reasoning.effort } }
      : {}),
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

function responsesOutput(
  payload: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const output = payload.output as Array<Record<string, unknown>> | undefined;
  const reasoning = (output ?? [])
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => {
      const summary = item.summary as Array<Record<string, unknown>> | undefined;
      return (summary ?? []).flatMap((part) =>
        typeof part.text === "string" ? [part.text] : []
      );
    })
    .join("");
  const text = (output ?? []).flatMap((item) => {
    const content = item.content as Array<Record<string, unknown>> | undefined;
    return (content ?? []).flatMap((part) =>
      typeof part.text === "string" ? [part.text] : []
    );
  }).join("");
  const reasoningItems = (output ?? []).flatMap((item) =>
    item.type === "reasoning" &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0
      ? [{
          ...item,
          encrypted_content: wrapResponsesEncryptedContent(
            item.encrypted_content,
            codexReasoningOwner(model)
          )
        }]
      : []
  );
  const toolCalls = (output ?? []).flatMap((item, index) =>
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
      items: reasoningItems as ResponsesReasoningItem[],
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
  const content = item.content as Array<Record<string, unknown>> | undefined;
  return (content ?? [])
    .flatMap((part) => typeof part.text === "string" ? [part.text] : [])
    .join("");
}

function codexCompletionResponse(
  model: string,
  payload: Record<string, unknown>
): Response {
  const message = responsesOutput(payload, model);
  const hasOutput =
    (typeof message.content === "string" && message.content.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  return hasOutput
    ? jsonResponse(
        chatCompletion(model, message, normalizedOpenAiUsage(payload.usage))
      )
    : jsonResponse({ error: CODEX_EMPTY_RESPONSE_ERROR }, 502);
}

function codexTerminalError(payload: unknown): Record<string, unknown> {
  const record = typeof payload === "object" && payload !== null
    ? payload as Record<string, unknown>
    : {};
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined;
  const raw = typeof record.error === "object" && record.error !== null
    ? record.error as Record<string, unknown>
    : typeof response?.error === "object" && response.error !== null
      ? response.error as Record<string, unknown>
      : undefined;
  const details = typeof response?.incomplete_details === "object" && response.incomplete_details !== null
    ? response.incomplete_details as Record<string, unknown>
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

  reasoningWireShape(): string {
    return "openai-responses";
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
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
        const suffix = complete.startsWith(previous)
          ? complete.slice(previous.length)
          : "";
        if (suffix.length === 0) return [];
        emittedText.set(outputIndex, complete);
        hasAssistantContent = true;
        return [contentChunk(suffix)];
      };
      return mapSse(response, (event, data) => {
        const item = data as Record<string, unknown>;
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
          const outputIndex =
            typeof item.output_index === "number" ? item.output_index : 0;
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
          const output = item.item as Record<string, unknown> | undefined;
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
          const output = item.item as Record<string, unknown> | undefined;
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
            } as ResponsesReasoningItem;
            attachResponsesReasoningMetadata(delta, {
              items: [wrappedOutput],
              includeEncryptedContent: false
            });
            return [{
              id: randomId(18, "chatcmpl_"),
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta, finish_reason: null }]
            }];
          }
          if (output?.type !== "message") return [];
          const outputIndex =
            typeof item.output_index === "number" ? item.output_index : 0;
          return recoverMessage(output, outputIndex);
        }
        if (eventType === "response.completed") {
          const completed = item.response as Record<string, unknown> | undefined;
          const recovered = Array.isArray(completed?.output)
            ? completed.output.flatMap((output, outputIndex) =>
                typeof output === "object" &&
                output !== null &&
                (output as Record<string, unknown>).type === "message"
                  ? recoverMessage(
                      output as Record<string, unknown>,
                      outputIndex
                    )
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
      });
    }
    if (this.#forceStream) {
      const decoder = new SseDecoder();
      const events = [
        ...decoder.feed(await response.text()),
        ...decoder.flush()
      ];
      const completedOutput = new Map<number, Record<string, unknown>>();
      let completedResponse: Record<string, unknown> | undefined;
      let terminalFailure: Record<string, unknown> | undefined;
      for (const event of events) {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          if (
            event.event !== "response.output_item.done" &&
            event.event !== "response.completed"
          ) {
            continue;
          }
          throw new SseParseError(
            "provider SSE event contained malformed JSON",
            event.data.slice(0, 200)
          );
        }
        if (typeof payload !== "object" || payload === null) continue;
        const record = payload as Record<string, unknown>;
        const eventType = event.event ?? record.type;
        if (
          eventType === "response.output_item.done" &&
          typeof record.item === "object" &&
          record.item !== null
        ) {
          const outputIndex =
            typeof record.output_index === "number"
              ? record.output_index
              : completedOutput.size;
          completedOutput.set(
            outputIndex,
            record.item as Record<string, unknown>
          );
        }
        if (
          eventType === "response.completed" &&
          typeof record.response === "object" &&
          record.response !== null
        ) {
          completedResponse = record.response as Record<string, unknown>;
        }
        if (eventType === "response.failed" || eventType === "response.incomplete" || eventType === "error") {
          terminalFailure = codexTerminalError(record);
        }
      }
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
      throw new SseParseError(
        "provider SSE stream ended without response.completed"
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return codexCompletionResponse(model, payload);
  }
}
