/**
 * Codex Responses provider codec. Pure request/response translation between
 * OpenAI Chat Completions JSON and the OpenAI Responses API as Codex speaks
 * it, including SSE deltas. HTTP transport lives in `codex-responses-backend.ts`.
 *
 * This is the outbound provider path (gateway → Codex). The inbound Responses
 * adapter lives under `adapters/responses-codec.ts`.
 */

import { randomId } from "@velum-labs/routekit-runtime/timing";
import { droppedField } from "../adapters/dropped.js";
import {
  attachResponsesReasoningMetadata,
  reasoningSelectionOf,
  responsesReasoningItem,
  responsesReasoningMetadataOf
} from "../adapters/openai-chat-wire.js";
import {
  normalizeOpenAiResponsesCallIds,
  prepareResponsesReasoningInput,
  type ResponsesReasoningOwner,
  wrapResponsesEncryptedContent
} from "../adapters/openai-responses-wire.js";
import { jsonResponse } from "../http/response.js";
import {
  type ChatBody,
  chatCompletion,
  normalizedOpenAiUsage,
  textContent
} from "./backend-core.js";
import {
  isProviderRecord,
  ProviderProtocolError,
  type ProviderRecord
} from "./protocol.js";

export function responsesRequest(
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

export function codexReasoningModeError(body: ChatBody): string | undefined {
  const reasoning = reasoningSelectionOf(body);
  if (reasoning.mode === "budget" || reasoning.mode === "adaptive") {
    return `Codex Responses cannot represent reasoning mode "${reasoning.mode}"`;
  }
  return undefined;
}

export function codexReasoningOwner(model: string): ResponsesReasoningOwner {
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

export const CODEX_EMPTY_RESPONSE_ERROR = {
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

export function codexCompletionResponse(model: string, payload: Record<string, unknown>): Response {
  const message = responsesOutput(payload, model);
  const hasOutput =
    (typeof message.content === "string" && message.content.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  return hasOutput
    ? jsonResponse(chatCompletion(model, message, normalizedOpenAiUsage(payload.usage)))
    : jsonResponse({ error: CODEX_EMPTY_RESPONSE_ERROR }, 502);
}

export function codexTerminalError(payload: unknown): Record<string, unknown> {
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

export type CodexStreamState = {
  hasToolCalls: boolean;
  hasAssistantContent: boolean;
  emittedText: Map<number, string>;
};

export function createCodexStreamState(): CodexStreamState {
  return { hasToolCalls: false, hasAssistantContent: false, emittedText: new Map() };
}

function contentChunk(model: string, content: string): Record<string, unknown> {
  return {
    id: randomId(18, "chatcmpl_"),
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  };
}

function recoverMessage(
  state: CodexStreamState,
  model: string,
  output: Record<string, unknown>,
  outputIndex: number
): Record<string, unknown>[] {
  const complete = responsesItemText(output);
  const previous = state.emittedText.get(outputIndex) ?? "";
  const suffix = complete.startsWith(previous) ? complete.slice(previous.length) : "";
  if (suffix.length === 0) return [];
  state.emittedText.set(outputIndex, complete);
  state.hasAssistantContent = true;
  return [contentChunk(model, suffix)];
}

export function codexSseToChatChunks(
  event: string,
  item: ProviderRecord,
  model: string,
  state: CodexStreamState
): unknown[] {
  const eventType = event === "message" && typeof item.type === "string" ? item.type : event;
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
    state.emittedText.set(outputIndex, `${state.emittedText.get(outputIndex) ?? ""}${delta}`);
    if (delta.length === 0) return [];
    state.hasAssistantContent = true;
    return [contentChunk(model, delta)];
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
    state.hasToolCalls = true;
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
    return recoverMessage(state, model, output, outputIndex);
  }
  if (eventType === "response.completed") {
    const completed = isProviderRecord(item.response) ? item.response : undefined;
    const recovered = Array.isArray(completed?.output)
      ? completed.output.flatMap((output, outputIndex) =>
          isProviderRecord(output) && output.type === "message"
            ? recoverMessage(state, model, output, outputIndex)
            : []
        )
      : [];
    if (!state.hasAssistantContent && !state.hasToolCalls) {
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
            finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
          }
        ],
        ...(completed?.usage !== undefined ? { usage: normalizedOpenAiUsage(completed.usage) } : {})
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
}

export type CodexForceStreamState = {
  completedOutput: Map<number, Record<string, unknown>>;
  completedResponse?: Record<string, unknown>;
  terminalFailure?: Record<string, unknown>;
};

export function createCodexForceStreamState(): CodexForceStreamState {
  return { completedOutput: new Map() };
}

export function applyCodexForceStreamEvent(
  eventType: unknown,
  record: ProviderRecord,
  state: CodexForceStreamState
): void {
  if (eventType === "response.output_item.done" && isProviderRecord(record.item)) {
    const outputIndex =
      typeof record.output_index === "number" ? record.output_index : state.completedOutput.size;
    state.completedOutput.set(outputIndex, { ...record.item });
  }
  if (eventType === "response.completed" && isProviderRecord(record.response)) {
    state.completedResponse = { ...record.response };
  }
  if (
    eventType === "response.failed" ||
    eventType === "response.incomplete" ||
    eventType === "error"
  ) {
    state.terminalFailure = codexTerminalError(record);
  }
}

export function codexForceStreamResponse(
  model: string,
  state: CodexForceStreamState
): Response | undefined {
  if (state.completedResponse !== undefined) {
    const terminalOutput = Array.isArray(state.completedResponse.output)
      ? [...state.completedResponse.output]
      : [];
    for (const [outputIndex, output] of state.completedOutput) {
      if (terminalOutput[outputIndex] === undefined) {
        terminalOutput[outputIndex] = output;
      }
    }
    const payload = { ...state.completedResponse, output: terminalOutput };
    return codexCompletionResponse(model, payload);
  }
  if (state.terminalFailure !== undefined) {
    return jsonResponse({ error: state.terminalFailure }, 502);
  }
  return undefined;
}
