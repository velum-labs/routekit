/**
 * Anthropic Messages provider codec. Pure request/response translation between
 * OpenAI Chat Completions JSON and the Anthropic Messages API, including SSE
 * deltas. HTTP transport lives in `anthropic-backend.ts`.
 *
 * This is the outbound provider path (gateway → Anthropic). The inbound Claude
 * Code adapter lives under `adapters/anthropic-codec.ts`.
 */

import type { Reasoning } from "@velum-labs/routekit-contracts/protocol-ir";
import { randomId } from "@velum-labs/routekit-runtime/timing";
import { droppedField } from "../adapters/dropped.js";
import {
  type AnthropicNativeContentBlock,
  type AnthropicRequestMetadata,
  anthropicMessageContentOf,
  anthropicReasoningDetailsOf,
  anthropicReasoningExtension,
  anthropicRequestMetadataOf,
  reasoningIndex,
  reasoningSelectionOf
} from "../adapters/openai-chat-wire.js";
import {
  type ChatBody,
  type ChatMessage,
  chatCompletion,
  normalizedOpenAiUsage,
  textContent
} from "./backend-core.js";
import { isProviderRecord, ProviderProtocolError, type ProviderRecord } from "./protocol.js";

const BLANK_TURN_PLACEHOLDER = "(continue)";

function anthropicContentIsEmpty(message: Record<string, unknown> | undefined): boolean {
  return Array.isArray(message?.content) && message.content.length === 0;
}

function anthropicImageBlock(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const imageUrl = part.image_url;
  const url =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl === "object" &&
          imageUrl !== null &&
          typeof (imageUrl as { url?: unknown }).url === "string"
        ? (imageUrl as { url: string }).url
        : undefined;
  if (url === undefined) return undefined;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl !== null) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] }
    };
  }
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return undefined;
}

/**
 * Translate OpenAI chat content into Anthropic content blocks.
 *
 * Anthropic rejects text blocks that are empty or whitespace-only, so those are
 * skipped here rather than sent upstream. Callers must handle the resulting
 * empty block list; see {@link anthropicMessages}.
 */
function anthropicContentBlocks(content: unknown, context: string): Record<string, unknown>[] {
  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "image_url") {
      const image = anthropicImageBlock(record);
      if (image !== undefined) blocks.push(image);
      else droppedField("anthropic", "image_url", context);
      continue;
    }
    if (typeof record.text === "string") {
      if (record.text.trim().length > 0) blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (typeof record.type === "string") droppedField("anthropic", record.type, context);
  }
  return blocks;
}

function anthropicNativeContent(message: ChatMessage): AnthropicNativeContentBlock[] | undefined {
  const content = anthropicMessageContentOf(message);
  if (Array.isArray(content)) return content;
  const details = anthropicReasoningDetailsOf(message.reasoning_details, "message")
    .filter((detail) => {
      const metadata = anthropicReasoningExtension(detail);
      return (
        metadata?.redacted === true ||
        (typeof metadata?.signature === "string" && metadata.signature.length > 0)
      );
    })
    .sort((a, b) => reasoningIndex(a) - reasoningIndex(b));
  if (details.length === 0) return undefined;
  const native: AnthropicNativeContentBlock[] = details.map(
    (detail): AnthropicNativeContentBlock => {
      const metadata = anthropicReasoningExtension(detail);
      return metadata?.redacted === true
        ? { type: "redacted_thinking", data: detail.encryptedContent ?? "" }
        : {
            type: "thinking",
            thinking: detail.text ?? "",
            signature: metadata?.signature ?? ""
          };
    }
  );
  const text = textContent(message.content);
  if (text.trim().length > 0) native.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      input = { raw: call.function?.arguments ?? "" };
    }
    native.push({
      type: "tool_use",
      id: call.id ?? randomId(12, "toolu_"),
      name: call.function?.name ?? "tool",
      input
    });
  }
  return native;
}

function anthropicMetadata(body: ChatBody): AnthropicRequestMetadata | undefined {
  return anthropicRequestMetadataOf(body);
}

function anthropicToolChoice(
  choice: unknown,
  parallelToolCalls: boolean | undefined
): Record<string, unknown> | undefined {
  const disableParallel = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === "auto") return { type: "auto", ...disableParallel };
  if (choice === "required") return { type: "any", ...disableParallel };
  if (choice === "none") return { type: "none", ...disableParallel };
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
    return parallelToolCalls === false ? { type: "auto", ...disableParallel } : undefined;
  }
  const fn = (choice as { function?: { name?: unknown } }).function;
  return typeof fn?.name === "string"
    ? { type: "tool", name: fn.name, ...disableParallel }
    : undefined;
}

function anthropicStructuredOutputFormat(
  responseFormat: ChatBody["response_format"]
): Record<string, unknown> | undefined {
  if (
    responseFormat?.type !== "json_schema" ||
    typeof responseFormat.json_schema?.schema !== "object" ||
    responseFormat.json_schema.schema === null
  ) {
    return undefined;
  }
  return {
    type: "json_schema",
    schema: responseFormat.json_schema.schema
  };
}

export function anthropicMessages(body: ChatBody, model: string): Record<string, unknown> {
  const system = (body.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .join("\n\n");
  const messages = (body.messages ?? []).flatMap((message): Record<string, unknown>[] => {
    if (message.role === "system") return [];
    const nativeContent = anthropicNativeContent(message);
    if (message.role === "assistant" && nativeContent !== undefined) {
      return [{ role: "assistant", content: nativeContent }];
    }
    if (message.role === "tool") {
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id ?? "",
              content: textContent(message.content)
            }
          ]
        }
      ];
    }
    const content: unknown[] = anthropicContentBlocks(
      message.content,
      `${message.role ?? "user"}_message`
    );
    for (const call of message.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        input = { raw: call.function?.arguments ?? "" };
      }
      content.push({
        type: "tool_use",
        id: call.id ?? randomId(12, "toolu_"),
        name: call.function?.name ?? "tool",
        input
      });
    }
    return [{ role: message.role === "assistant" ? "assistant" : "user", content }];
  });
  // Anthropic rejects any user turn whose content list is empty, and OpenAI
  // clients legitimately send blank turns. Adjacent turns of the same role are
  // coalesced upstream, so dropping a blank turn loses nothing — except when it
  // was the closing turn, which models that forbid assistant prefill require.
  const kept = messages.filter((message) => !anthropicContentIsEmpty(message));
  if (anthropicContentIsEmpty(messages.at(-1)) && kept.at(-1)?.role !== "user") {
    kept.push({ role: "user", content: [{ type: "text", text: BLANK_TURN_PLACEHOLDER }] });
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  const metadata = anthropicMetadata(body);
  const selection = reasoningSelectionOf(body);
  const translatedThinking: AnthropicRequestMetadata["thinking"] | undefined =
    selection.mode === "budget"
      ? { type: "enabled", budget_tokens: selection.budgetTokens }
      : selection.mode === "adaptive" || selection.mode === "effort"
        ? { type: "adaptive" }
        : selection.mode === "disabled"
          ? { type: "disabled" }
          : undefined;
  const translatedOutput = selection.mode === "effort" ? { effort: selection.effort } : undefined;
  const thinking = metadata?.thinking ?? translatedThinking;
  const structuredOutputFormat = anthropicStructuredOutputFormat(body.response_format);
  const outputConfig =
    metadata?.output_config != null
      ? {
          ...metadata.output_config,
          ...(structuredOutputFormat !== undefined &&
          !Object.hasOwn(metadata.output_config, "format")
            ? { format: structuredOutputFormat }
            : {})
        }
      : translatedOutput !== undefined || structuredOutputFormat !== undefined
        ? {
            ...translatedOutput,
            ...(structuredOutputFormat !== undefined ? { format: structuredOutputFormat } : {})
          }
        : undefined;
  const toolChoice = anthropicToolChoice(body.tool_choice, body.parallel_tool_calls);
  return {
    model,
    messages: kept,
    max_tokens: maxTokens,
    stream: body.stream === true,
    ...(system.trim().length > 0 ? { system } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.top_k !== undefined ? { top_k: body.top_k } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.tools !== undefined
      ? {
          tools: body.tools.flatMap((tool) =>
            tool.function === undefined
              ? []
              : [
                  {
                    name: tool.function.name,
                    description: tool.function.description,
                    input_schema: tool.function.parameters ?? { type: "object" }
                  }
                ]
          )
        }
      : {})
  };
}

export function anthropicThinkingValidationError(body: ChatBody): string | undefined {
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  const exact = anthropicMetadata(body)?.thinking;
  const selection = reasoningSelectionOf(body);
  const budget =
    exact?.type === "enabled"
      ? exact.budget_tokens
      : selection.mode === "budget"
        ? selection.budgetTokens
        : undefined;
  if (budget !== undefined) {
    if (!Number.isInteger(budget) || budget < 1_024 || budget >= maxTokens) {
      return `thinking.budget_tokens must be an integer >= 1024 and less than max_tokens (${maxTokens})`;
    }
  }
  return undefined;
}

export function openAiFinishReasonFromAnthropic(stopReason: unknown): string {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    return "length";
  }
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

export function anthropicSseToChatChunks(
  event: string,
  item: ProviderRecord,
  model: string,
  blockTypes: Map<number, string>
): unknown[] {
  const delta = isProviderRecord(item.delta) ? item.delta : undefined;
  if (event === "message_start") {
    const message = isProviderRecord(item.message) ? item.message : undefined;
    return message?.usage === undefined
      ? []
      : [
          {
            id: randomId(18, "chatcmpl_"),
            object: "chat.completion.chunk",
            model,
            choices: [],
            usage: normalizedOpenAiUsage(message.usage)
          }
        ];
  }
  if (event === "content_block_start") {
    const block = isProviderRecord(item.content_block) ? item.content_block : undefined;
    const sourceIndex = typeof item.index === "number" ? item.index : 0;
    if (typeof block?.type === "string") blockTypes.set(sourceIndex, block.type);
    if (block?.type === "tool_use") {
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
                    index: item.index ?? 0,
                    id: block.id,
                    type: "function",
                    function: { name: block.name, arguments: "" }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        }
      ];
    }
    if (block?.type === "thinking") {
      return [
        {
          id: randomId(18, "chatcmpl_"),
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  {
                    type: "thinking",
                    index: sourceIndex,
                    phase: "start",
                    signature: typeof block.signature === "string" ? block.signature : ""
                  }
                ]
              },
              finish_reason: null
            }
          ]
        }
      ];
    }
    if (block?.type === "redacted_thinking" && typeof block.data === "string") {
      return [
        {
          id: randomId(18, "chatcmpl_"),
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  {
                    type: "redacted_thinking",
                    index: sourceIndex,
                    phase: "block",
                    data: block.data
                  }
                ]
              },
              finish_reason: null
            }
          ]
        }
      ];
    }
  }
  if (event === "content_block_delta") {
    const sourceIndex = typeof item.index === "number" ? item.index : 0;
    const content = delta?.type === "text_delta" ? delta.text : undefined;
    const toolArguments = delta?.type === "input_json_delta" ? delta.partial_json : undefined;
    const reasoning = delta?.type === "thinking_delta" ? delta.thinking : undefined;
    const signature = delta?.type === "signature_delta" ? delta.signature : undefined;
    return [
      {
        id: randomId(18, "chatcmpl_"),
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta:
              toolArguments !== undefined
                ? {
                    tool_calls: [
                      {
                        index: item.index ?? 0,
                        function: { arguments: toolArguments }
                      }
                    ]
                  }
                : reasoning !== undefined
                  ? {
                      reasoning,
                      reasoning_details: [
                        {
                          type: "thinking",
                          index: sourceIndex,
                          phase: "delta",
                          thinking: reasoning
                        }
                      ]
                    }
                  : signature !== undefined
                    ? {
                        reasoning_details: [
                          {
                            type: "thinking",
                            index: sourceIndex,
                            phase: "signature",
                            signature
                          }
                        ]
                      }
                    : { content },
            finish_reason: null
          }
        ]
      }
    ];
  }
  if (event === "content_block_stop") {
    const sourceIndex = typeof item.index === "number" ? item.index : 0;
    if (blockTypes.get(sourceIndex) === "thinking") {
      return [
        {
          id: randomId(18, "chatcmpl_"),
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  {
                    type: "thinking",
                    index: sourceIndex,
                    phase: "stop"
                  }
                ]
              },
              finish_reason: null
            }
          ]
        }
      ];
    }
    return [];
  }
  if (event === "message_delta") {
    const stopReason = delta?.stop_reason;
    return [
      {
        id: randomId(18, "chatcmpl_"),
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: openAiFinishReasonFromAnthropic(stopReason),
            ...(typeof stopReason === "string" ? { anthropic_stop_reason: stopReason } : {}),
            ...(typeof delta?.stop_sequence === "string"
              ? { anthropic_stop_sequence: delta.stop_sequence }
              : {})
          }
        ],
        ...(item.usage !== undefined ? { usage: normalizedOpenAiUsage(item.usage) } : {})
      }
    ];
  }
  return [];
}

export function fromAnthropicMessage(payload: ProviderRecord, model: string): unknown {
  if (!Array.isArray(payload.content)) {
    throw new ProviderProtocolError(
      "anthropic",
      "message response",
      '"content" must be an array',
      payload.content
    );
  }
  const blocks = payload.content.flatMap((candidate): Record<string, unknown>[] =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      ? [candidate as Record<string, unknown>]
      : []
  );
  const content = blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  const reasoning = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => String(block.thinking ?? ""))
    .join("");
  const reasoningDetails = blocks.flatMap((block, index): Reasoning[] => {
    if (block.type === "thinking") {
      return [
        {
          text: String(block.thinking ?? ""),
          extensions: [
            {
              namespace: "anthropic.reasoning",
              value: {
                index,
                signature: typeof block.signature === "string" ? block.signature : ""
              }
            }
          ]
        }
      ];
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      return [
        {
          encryptedContent: block.data,
          extensions: [
            {
              namespace: "anthropic.reasoning",
              value: { index, redacted: true }
            }
          ]
        }
      ];
    }
    return [];
  });
  const toolCalls = blocks.flatMap((block, index) =>
    block.type === "tool_use"
      ? [
          {
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            index
          }
        ]
      : []
  );
  return chatCompletion(
    model,
    {
      role: "assistant",
      content: content.length > 0 ? content : null,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    },
    normalizedOpenAiUsage(payload.usage),
    openAiFinishReasonFromAnthropic(payload.stop_reason),
    {
      ...(typeof payload.stop_reason === "string"
        ? { anthropic_stop_reason: payload.stop_reason }
        : {}),
      ...(typeof payload.stop_sequence === "string"
        ? { anthropic_stop_sequence: payload.stop_sequence }
        : {})
    }
  );
}
