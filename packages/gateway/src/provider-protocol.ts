import type { Citation, ToolResult, Usage } from "@velum-labs/routekit-contracts/protocol-ir";
import type { OpenAiChoice } from "./adapters/openai-chat-wire.js";

export class ProviderProtocolError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly payloadSnippet?: string;

  constructor(
    provider: string,
    operation: string,
    message: string,
    payload?: unknown,
    options?: ErrorOptions
  ) {
    super(`${provider} ${operation}: ${message}`, options);
    this.name = "ProviderProtocolError";
    this.provider = provider;
    this.operation = operation;
    const snippet = payloadSnippet(payload);
    if (snippet !== undefined) this.payloadSnippet = snippet;
  }
}

export type ProviderRecord = Readonly<Record<string, unknown>>;

export type OpenAiChatResponse = ProviderRecord & {
  readonly id?: string;
  readonly choices: OpenAiChoice[];
  readonly usage?: Usage;
  readonly provider_cost?: unknown;
};

export type OpenAiChatSseEvent = ProviderRecord & {
  readonly choices: OpenAiChoice[];
  readonly usage?: Usage | null;
  readonly provider_cost?: unknown;
  readonly error?: Readonly<{
    message?: string;
    type?: string;
    code?: string;
  }>;
};

export type OpenAiResponsesEvent = ProviderRecord & {
  readonly type: string;
};

export type AnthropicSseEvent = ProviderRecord & {
  readonly type: string;
};

export type GoogleGenerateContent = ProviderRecord & {
  readonly candidates: readonly ProviderRecord[];
  readonly usageMetadata?: ProviderRecord;
};

export type ModelCatalogEntry = ProviderRecord & {
  readonly id: string;
};

export type ModelCatalogPayload = ProviderRecord & {
  readonly data: ModelCatalogEntry[];
};

function payloadSnippet(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

export function isProviderRecord(value: unknown): value is ProviderRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(
  value: unknown,
  provider: string,
  operation: string,
  description: string
): ProviderRecord {
  if (!isProviderRecord(value)) {
    throw new ProviderProtocolError(provider, operation, `${description} must be an object`, value);
  }
  return value;
}

function optionalRecord(
  value: unknown,
  provider: string,
  operation: string,
  field: string
): ProviderRecord | undefined {
  if (value === undefined || value === null) return undefined;
  return record(value, provider, operation, `"${field}"`);
}

function optionalString(
  value: unknown,
  provider: string,
  operation: string,
  field: string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ProviderProtocolError(provider, operation, `"${field}" must be a string`, value);
  }
  return value;
}

function decodeOpenAiUsage(value: unknown, operation: string): Usage | undefined {
  const usage = optionalRecord(value, "openai-chat", operation, "usage");
  if (usage === undefined) return undefined;
  const numericFields = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;
  for (const field of numericFields) {
    if (usage[field] !== undefined && typeof usage[field] !== "number") {
      throw new ProviderProtocolError(
        "openai-chat",
        operation,
        `"usage.${field}" must be a number`,
        usage[field]
      );
    }
  }
  const promptDetails = optionalRecord(
    usage.prompt_tokens_details,
    "openai-chat",
    operation,
    "usage.prompt_tokens_details"
  );
  const completionDetails = optionalRecord(
    usage.completion_tokens_details,
    "openai-chat",
    operation,
    "usage.completion_tokens_details"
  );
  return {
    ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number"
      ? { outputTokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(promptDetails !== undefined || completionDetails !== undefined
      ? {
          extensions: [
            {
              namespace: "openai.chat.usage-details",
              value: {
                ...(promptDetails !== undefined ? { promptTokens: promptDetails } : {}),
                ...(completionDetails !== undefined ? { completionTokens: completionDetails } : {})
              }
            }
          ]
        }
      : {})
  };
}

function decodeOpenAiChoices(value: unknown, operation: string): OpenAiChoice[] {
  if (!Array.isArray(value)) {
    throw new ProviderProtocolError("openai-chat", operation, '"choices" must be an array', value);
  }
  return value.map((candidate): OpenAiChoice => {
    const choice = record(candidate, "openai-chat", operation, "choice");
    const delta = optionalRecord(choice.delta, "openai-chat", operation, "choice.delta");
    const message = optionalRecord(choice.message, "openai-chat", operation, "choice.message");
    const decodeContent = (
      source: ProviderRecord | undefined,
      field: "content" | "reasoning" | "reasoning_content"
    ): string | null | undefined => {
      const candidateValue = source?.[field];
      if (candidateValue === null) return null;
      return optionalString(candidateValue, "openai-chat", operation, `choice.${field}`);
    };
    const decodedDelta =
      delta === undefined
        ? undefined
        : {
            ...delta,
            ...(decodeContent(delta, "content") !== undefined
              ? { content: decodeContent(delta, "content") }
              : {}),
            ...(decodeContent(delta, "reasoning") !== undefined
              ? { reasoning: decodeContent(delta, "reasoning") }
              : {}),
            ...(decodeContent(delta, "reasoning_content") !== undefined
              ? { reasoning_content: decodeContent(delta, "reasoning_content") }
              : {}),
            ...(Array.isArray(delta.reasoning_details)
              ? { reasoning_details: delta.reasoning_details }
              : {}),
            ...(Array.isArray(delta.tool_calls) ? { tool_calls: delta.tool_calls } : {})
          };
    const decodedMessage =
      message === undefined
        ? undefined
        : {
            ...message,
            ...(decodeContent(message, "content") !== undefined
              ? { content: decodeContent(message, "content") }
              : {}),
            ...(decodeContent(message, "reasoning") !== undefined
              ? { reasoning: decodeContent(message, "reasoning") }
              : {}),
            ...(decodeContent(message, "reasoning_content") !== undefined
              ? { reasoning_content: decodeContent(message, "reasoning_content") }
              : {}),
            ...(Array.isArray(message.reasoning_details)
              ? { reasoning_details: message.reasoning_details }
              : {}),
            ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {})
          };
    return {
      ...choice,
      ...(decodedDelta !== undefined ? { delta: decodedDelta } : {}),
      ...(decodedMessage !== undefined ? { message: decodedMessage } : {}),
      ...(choice.finish_reason === null
        ? { finish_reason: null }
        : typeof choice.finish_reason === "string"
          ? { finish_reason: choice.finish_reason }
          : {}),
      ...(choice.anthropic_stop_reason === null
        ? { anthropic_stop_reason: null }
        : typeof choice.anthropic_stop_reason === "string"
          ? { anthropic_stop_reason: choice.anthropic_stop_reason }
          : {}),
      ...(choice.anthropic_stop_sequence === null
        ? { anthropic_stop_sequence: null }
        : typeof choice.anthropic_stop_sequence === "string"
          ? { anthropic_stop_sequence: choice.anthropic_stop_sequence }
          : {})
    };
  });
}

export function decodeProviderJson(
  provider: string,
  operation: string,
  value: unknown
): ProviderRecord {
  return record(value, provider, operation, "payload");
}

export function decodeModelCatalogPayload(
  value: unknown,
  provider = "gateway"
): ModelCatalogPayload {
  const payload = record(value, provider, "model catalog", "payload");
  if (!Array.isArray(payload.data)) {
    throw new ProviderProtocolError(
      provider,
      "model catalog",
      '"data" must be an array',
      payload.data
    );
  }
  const data = payload.data.map((candidate): ModelCatalogEntry => {
    const entry = record(candidate, provider, "model catalog", "model");
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new ProviderProtocolError(
        provider,
        "model catalog",
        'model "id" must be a non-empty string',
        entry.id
      );
    }
    return { ...entry, id: entry.id };
  });
  return { ...payload, data };
}

export function decodeOpenAiChatResponse(value: unknown): OpenAiChatResponse {
  const payload = record(value, "openai-chat", "response", "payload");
  const choices = decodeOpenAiChoices(payload.choices, "response");
  const usage = decodeOpenAiUsage(payload.usage, "response");
  return {
    ...payload,
    choices,
    ...(usage !== undefined ? { usage } : {})
  };
}

export function decodeOpenAiChatSseEvent(value: unknown): OpenAiChatSseEvent {
  const payload = record(value, "openai-chat", "SSE event", "payload");
  const choicesValue = payload.choices ?? [];
  const choices = decodeOpenAiChoices(choicesValue, "SSE event");
  const usage = payload.usage === null ? null : decodeOpenAiUsage(payload.usage, "SSE event");
  const errorRecord = optionalRecord(payload.error, "openai-chat", "SSE event", "error");
  const error =
    errorRecord === undefined
      ? undefined
      : {
          ...(optionalString(errorRecord.message, "openai-chat", "SSE event", "error.message") !==
          undefined
            ? { message: errorRecord.message as string }
            : {}),
          ...(optionalString(errorRecord.type, "openai-chat", "SSE event", "error.type") !==
          undefined
            ? { type: errorRecord.type as string }
            : {}),
          ...(optionalString(errorRecord.code, "openai-chat", "SSE event", "error.code") !==
          undefined
            ? { code: errorRecord.code as string }
            : {})
        };
  return {
    ...payload,
    choices,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {})
  };
}

export function decodeOpenAiResponsesEvent(
  value: unknown,
  eventType?: string
): OpenAiResponsesEvent {
  const payload = record(value, "openai-responses", "SSE event", "payload");
  const type =
    typeof payload.type === "string" && payload.type.length > 0 ? payload.type : eventType;
  if (type === undefined || type.length === 0) {
    throw new ProviderProtocolError(
      "openai-responses",
      "SSE event",
      '"type" must be a non-empty string',
      payload.type
    );
  }
  return { ...payload, type };
}

export function decodeAnthropicSseEvent(value: unknown, eventType?: string): AnthropicSseEvent {
  const payload = record(value, "anthropic", "SSE event", "payload");
  const type =
    typeof payload.type === "string" && payload.type.length > 0 ? payload.type : eventType;
  if (type === undefined || type.length === 0) {
    throw new ProviderProtocolError(
      "anthropic",
      "SSE event",
      '"type" must be a non-empty string',
      payload.type
    );
  }
  return { ...payload, type };
}

export function decodeGoogleGenerateContent(value: unknown): GoogleGenerateContent {
  const payload = record(value, "google", "generate-content response", "payload");
  const candidatesValue = payload.candidates ?? [];
  if (!Array.isArray(candidatesValue)) {
    throw new ProviderProtocolError(
      "google",
      "generate-content response",
      '"candidates" must be an array',
      candidatesValue
    );
  }
  const candidates = candidatesValue.map((candidate) =>
    record(candidate, "google", "generate-content response", "candidate")
  );
  for (const candidate of candidates) {
    const content = optionalRecord(
      candidate.content,
      "google",
      "generate-content response",
      "candidate.content"
    );
    if (content?.parts !== undefined && !Array.isArray(content.parts)) {
      throw new ProviderProtocolError(
        "google",
        "generate-content response",
        '"candidate.content.parts" must be an array',
        content.parts
      );
    }
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      record(part, "google", "generate-content response", "content part");
    }
  }
  const usageMetadata = optionalRecord(
    payload.usageMetadata,
    "google",
    "generate-content response",
    "usageMetadata"
  );
  return {
    ...payload,
    candidates,
    ...(usageMetadata !== undefined ? { usageMetadata } : {})
  };
}

export function decodeOpenAiToolCalls(value: unknown): readonly ProviderRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderProtocolError(
      "openai-chat",
      "tool calls",
      '"tool_calls" must be an array',
      value
    );
  }
  return value.map((call) => record(call, "openai-chat", "tool calls", "tool call"));
}

function citation(value: unknown, provider: string): Citation | undefined {
  if (!isProviderRecord(value) || typeof value.url !== "string" || value.url.length === 0) {
    return undefined;
  }
  return {
    url: value.url,
    ...(typeof value.title === "string" && value.title.length > 0 ? { title: value.title } : {})
  };
}

export function decodeToolResult(
  provider: string,
  value: unknown,
  options: { toolCallId?: string; isError?: boolean } = {}
): ToolResult {
  if (typeof value === "string") {
    return {
      ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
      content: value,
      isError: options.isError ?? false,
      citations: []
    };
  }
  if (Array.isArray(value)) {
    const citations = value.flatMap((entry) => {
      const decoded = citation(entry, provider);
      return decoded === undefined ? [] : [decoded];
    });
    return {
      ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
      content: JSON.stringify(value),
      isError: options.isError ?? false,
      citations,
      extensions: [{ namespace: provider, value }]
    };
  }
  if (isProviderRecord(value)) {
    return {
      ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
      content: JSON.stringify(value),
      isError: options.isError ?? false,
      citations: [],
      extensions: [{ namespace: provider, value }]
    };
  }
  throw new ProviderProtocolError(
    provider,
    "tool result",
    "result must be text, an object, or an array",
    value
  );
}

export function decodeOpenAiWebSearchResult(value: unknown): ToolResult {
  const payload = record(value, "openai", "web-search response", "payload");
  if (!Array.isArray(payload.output)) {
    throw new ProviderProtocolError(
      "openai",
      "web-search response",
      '"output" must be an array',
      payload.output
    );
  }
  const text: string[] = [];
  const citations: Citation[] = [];
  for (const candidate of payload.output) {
    const item = record(candidate, "openai", "web-search response", "output item");
    if (item.type !== "message") continue;
    if (!Array.isArray(item.content)) {
      throw new ProviderProtocolError(
        "openai",
        "web-search response",
        'message "content" must be an array',
        item.content
      );
    }
    for (const candidatePart of item.content) {
      const part = record(candidatePart, "openai", "web-search response", "content part");
      if (typeof part.text === "string" && part.text.length > 0) text.push(part.text);
      if (part.annotations === undefined) continue;
      if (!Array.isArray(part.annotations)) {
        throw new ProviderProtocolError(
          "openai",
          "web-search response",
          '"annotations" must be an array',
          part.annotations
        );
      }
      for (const annotation of part.annotations) {
        const decoded = citation(annotation, "openai");
        if (
          isProviderRecord(annotation) &&
          annotation.type === "url_citation" &&
          decoded !== undefined
        ) {
          citations.push(decoded);
        }
      }
    }
  }
  return { content: text.join("\n"), isError: false, citations };
}

export function decodeAnthropicWebSearchResult(value: unknown): ToolResult {
  const payload = record(value, "anthropic", "web-search response", "payload");
  if (!Array.isArray(payload.content)) {
    throw new ProviderProtocolError(
      "anthropic",
      "web-search response",
      '"content" must be an array',
      payload.content
    );
  }
  const text: string[] = [];
  const citations: Citation[] = [];
  const resultBlocks: unknown[] = [];
  for (const candidate of payload.content) {
    const block = record(candidate, "anthropic", "web-search response", "content block");
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      text.push(block.text);
    }
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) {
      throw new ProviderProtocolError(
        "anthropic",
        "web-search response",
        'tool result "content" must be an array',
        block.content
      );
    }
    resultBlocks.push(...block.content);
    for (const result of block.content) {
      const decoded = citation(result, "anthropic");
      if (
        isProviderRecord(result) &&
        result.type === "web_search_result" &&
        decoded !== undefined
      ) {
        citations.push(decoded);
      }
    }
  }
  return {
    content: text.join("\n"),
    isError: false,
    citations,
    ...(resultBlocks.length > 0
      ? { extensions: [{ namespace: "anthropic.web-search-results", value: resultBlocks }] }
      : {})
  };
}
