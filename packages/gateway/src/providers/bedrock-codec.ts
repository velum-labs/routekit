/**
 * Bedrock Converse codec. Pure request/response translation between OpenAI
 * Chat Completions JSON and Amazon Bedrock Converse, including streaming SSE.
 * Model discovery and transport live in `bedrock-source.ts`.
 */

import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamOutput,
  Message,
  SystemContentBlock,
  Tool
} from "@aws-sdk/client-bedrock-runtime";
import type { Reasoning } from "@velum-labs/routekit-contracts/protocol-ir";
import { randomId } from "@velum-labs/routekit-runtime/timing";
import {
  anthropicReasoningDetailsOf,
  anthropicReasoningExtension,
  reasoningIndex,
  reasoningSelectionOf,
  withoutRouteKitExtensions
} from "../adapters/openai-chat-wire.js";

type BedrockDocument = NonNullable<ConverseCommandInput["additionalModelRequestFields"]>;
type ChatMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  reasoning_details?: Reasoning[];
};
type ChatBody = {
  model?: unknown;
  messages?: ChatMessage[];
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: unknown };
  }>;
  tool_choice?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  stop?: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function isOpusFiveModel(modelId: string): boolean {
  return /(?:^|\.)anthropic\.claude-opus-5$/.test(modelId);
}
function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? [item.text] : [];
    })
    .join("");
}
function imageBlock(part: Record<string, unknown>): ContentBlock | undefined {
  const imageUrl =
    typeof part.image_url === "string" ? part.image_url : record(part.image_url)?.url;
  if (typeof imageUrl !== "string") return undefined;
  const match = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/s.exec(imageUrl);
  if (match === null) return undefined;
  return {
    image: {
      format: match[1] as "png" | "jpeg" | "gif" | "webp",
      source: { bytes: Uint8Array.from(Buffer.from(match[2]!, "base64")) }
    }
  };
}
function bedrockReasoningBlocks(details: unknown): ContentBlock[] {
  return anthropicReasoningDetailsOf(details, "message")
    .sort((left, right) => reasoningIndex(left) - reasoningIndex(right))
    .map((detail): ContentBlock => {
      const metadata = anthropicReasoningExtension(detail);
      return metadata?.redacted === true
        ? {
            reasoningContent: {
              redactedContent: Uint8Array.from(Buffer.from(detail.encryptedContent ?? "", "base64"))
            }
          }
        : {
            reasoningContent: {
              reasoningText: {
                text: detail.text ?? "",
                ...(metadata?.signature !== undefined ? { signature: metadata.signature } : {})
              }
            }
          };
    });
}

function messageContent(message: ChatMessage): ContentBlock[] {
  const blocks: ContentBlock[] =
    message.role === "assistant" ? bedrockReasoningBlocks(message.reasoning_details) : [];
  if (typeof message.content === "string") {
    if (message.content.length > 0) blocks.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const value of message.content) {
      const part = record(value);
      if (part === undefined) continue;
      if (part.type === "image_url") {
        const image = imageBlock(part);
        if (image !== undefined) blocks.push(image);
      } else if (typeof part.text === "string" && part.text.length > 0) {
        blocks.push({ text: part.text });
      }
    }
  }
  for (const call of message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      input = { raw: call.function?.arguments ?? "" };
    }
    blocks.push({
      toolUse: {
        toolUseId: call.id ?? randomId(12, "toolu_"),
        name: call.function?.name ?? "tool",
        input: input as BedrockDocument
      }
    });
  }
  return blocks;
}
function bedrockMessages(body: ChatBody): { system?: SystemContentBlock[]; messages: Message[] } {
  const systemText = (body.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textParts(message.content))
    .filter((text) => text.length > 0);
  const messages: Message[] = [];
  const sourceMessages = body.messages ?? [];
  for (let index = 0; index < sourceMessages.length; index += 1) {
    const message = sourceMessages[index]!;
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const content: ContentBlock[] = [];
      let cursor = index;
      while (cursor < sourceMessages.length && sourceMessages[cursor]?.role === "tool") {
        const toolMessage = sourceMessages[cursor]!;
        content.push({
          toolResult: {
            toolUseId: toolMessage.tool_call_id ?? "",
            content: [{ text: textParts(toolMessage.content) }]
          }
        });
        cursor += 1;
      }
      messages.push({ role: "user", content });
      index = cursor - 1;
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = messageContent(message);
    if (content.length > 0) messages.push({ role: message.role, content });
  }
  return {
    ...(systemText.length > 0 ? { system: systemText.map((text) => ({ text })) } : {}),
    messages
  };
}
function bedrockTools(body: ChatBody): Tool[] | undefined {
  const tools = (body.tools ?? []).flatMap((tool): Tool[] => {
    const fn = tool.function;
    if (tool.type !== "function" || typeof fn?.name !== "string") return [];
    return [
      {
        toolSpec: {
          name: fn.name,
          ...(typeof fn.description === "string" ? { description: fn.description } : {}),
          inputSchema: { json: (record(fn.parameters) ?? {}) as BedrockDocument }
        }
      }
    ];
  });
  return tools.length > 0 ? tools : undefined;
}
function toolChoice(value: unknown): NonNullable<ConverseCommandInput["toolConfig"]>["toolChoice"] {
  if (value === "required") return { any: {} };
  const name = record(record(value)?.function)?.name;
  if (typeof name === "string") return { tool: { name } };
  return { auto: {} };
}

export function toBedrockConverseInput(body: unknown): ConverseCommandInput {
  const canonical = withoutRouteKitExtensions(body) as ChatBody;
  if (typeof canonical.model !== "string" || canonical.model.length === 0)
    throw new Error("Bedrock chat requires a model");
  const translated = bedrockMessages(canonical);
  const tools = canonical.tool_choice === "none" ? undefined : bedrockTools(canonical);
  const maxTokens =
    typeof canonical.max_completion_tokens === "number"
      ? canonical.max_completion_tokens
      : canonical.max_tokens;
  const stops =
    typeof canonical.stop === "string"
      ? [canonical.stop]
      : Array.isArray(canonical.stop)
        ? canonical.stop.filter((value): value is string => typeof value === "string")
        : undefined;
  const selection = reasoningSelectionOf(body);
  const thinking: BedrockDocument | undefined =
    selection.mode === "budget"
      ? { thinking: { type: "enabled", budget_tokens: selection.budgetTokens } }
      : isOpusFiveModel(canonical.model)
        ? selection.mode === "effort"
          ? { thinking: { type: "adaptive" }, output_config: { effort: selection.effort } }
          : selection.mode === "adaptive"
            ? { thinking: { type: "adaptive" } }
            : selection.mode === "disabled"
              ? { thinking: { type: "disabled" } }
              : undefined
        : undefined;
  const additionalModelRequestFields: BedrockDocument | undefined =
    thinking !== undefined || typeof canonical.top_k === "number"
      ? ({
          ...(thinking as Record<string, BedrockDocument> | undefined),
          ...(typeof canonical.top_k === "number" ? { top_k: canonical.top_k } : {})
        } as BedrockDocument)
      : undefined;
  return {
    modelId: canonical.model,
    ...translated,
    ...(tools !== undefined
      ? { toolConfig: { tools, toolChoice: toolChoice(canonical.tool_choice) } }
      : {}),
    ...(typeof maxTokens === "number" ||
    typeof canonical.temperature === "number" ||
    typeof canonical.top_p === "number" ||
    stops !== undefined
      ? {
          inferenceConfig: {
            ...(typeof maxTokens === "number" ? { maxTokens } : {}),
            ...(typeof canonical.temperature === "number"
              ? { temperature: canonical.temperature }
              : {}),
            ...(typeof canonical.top_p === "number" ? { topP: canonical.top_p } : {}),
            ...(stops !== undefined ? { stopSequences: stops } : {})
          }
        }
      : {}),
    ...(additionalModelRequestFields !== undefined ? { additionalModelRequestFields } : {})
  };
}
function finishReason(reason: string | undefined): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
    case "guardrail_intervened":
      return "content_filter";
    default:
      return "stop";
  }
}
function usage(
  value: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const prompt = value.inputTokens ?? 0;
  const completion = value.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: value.totalTokens ?? prompt + completion
  };
}
function outputMessage(output: ConverseCommandOutput): Record<string, unknown> {
  const content = output.output?.message?.content ?? [];
  let text = "";
  let reasoning = "";
  const reasoningDetails: Reasoning[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const [index, block] of content.entries()) {
    if ("text" in block && typeof block.text === "string") text += block.text;
    if ("toolUse" in block && block.toolUse !== undefined)
      toolCalls.push({
        id: block.toolUse.toolUseId,
        type: "function",
        function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input ?? {}) }
      });
    if ("reasoningContent" in block && block.reasoningContent !== undefined) {
      if (
        "reasoningText" in block.reasoningContent &&
        block.reasoningContent.reasoningText !== undefined
      ) {
        const reasoningText = block.reasoningContent.reasoningText;
        reasoning += reasoningText.text ?? "";
        reasoningDetails.push({
          text: reasoningText.text ?? "",
          extensions: [
            {
              namespace: "anthropic.reasoning",
              value: { index, signature: reasoningText.signature ?? "" }
            }
          ]
        });
      } else if (
        "redactedContent" in block.reasoningContent &&
        block.reasoningContent.redactedContent !== undefined
      ) {
        reasoningDetails.push({
          encryptedContent: Buffer.from(block.reasoningContent.redactedContent).toString("base64"),
          extensions: [
            {
              namespace: "anthropic.reasoning",
              value: { index, redacted: true }
            }
          ]
        });
      }
    }
  }
  return {
    role: "assistant",
    content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}
export function fromBedrockConverseOutput(
  output: ConverseCommandOutput,
  model: string
): Record<string, unknown> {
  return {
    id: output.$metadata.requestId ?? randomId(18, "chatcmpl_"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: outputMessage(output), finish_reason: finishReason(output.stopReason) }
    ],
    ...(usage(output.usage) !== undefined ? { usage: usage(output.usage) } : {})
  };
}
function streamError(event: ConverseStreamOutput): Error | undefined {
  for (const key of [
    "internalServerException",
    "modelStreamErrorException",
    "validationException",
    "throttlingException",
    "serviceUnavailableException"
  ] as const) {
    const value = event[key];
    if (value !== undefined) return new Error(value.message ?? `Bedrock stream ${key}`);
  }
  return undefined;
}
function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
  );
}
export function streamResponse(
  stream: AsyncIterable<ConverseStreamOutput>,
  model: string,
  signal?: AbortSignal
): Response {
  const id = randomId(18, "chatcmpl_");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (
    delta: Record<string, unknown>,
    finishReasonValue: string | null = null,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReasonValue }],
    ...extra
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const indexes = new Map<number, number>();
      const reasoningIndexes = new Set<number>();
      let nextTool = 0;
      try {
        controller.enqueue(sse(chunk({ role: "assistant" })));
        for await (const event of stream) {
          if (signal?.aborted === true)
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const error = streamError(event);
          if (error !== undefined) throw error;
          if (event.contentBlockStart?.start?.toolUse !== undefined) {
            const sourceIndex = event.contentBlockStart.contentBlockIndex;
            const index = nextTool++;
            if (sourceIndex !== undefined) indexes.set(sourceIndex, index);
            const tool = event.contentBlockStart.start.toolUse;
            controller.enqueue(
              sse(
                chunk({
                  tool_calls: [
                    {
                      index,
                      id: tool.toolUseId,
                      type: "function",
                      function: { name: tool.name, arguments: "" }
                    }
                  ]
                })
              )
            );
          }
          const delta = event.contentBlockDelta?.delta;
          if (delta !== undefined && "text" in delta && typeof delta.text === "string")
            controller.enqueue(sse(chunk({ content: delta.text })));
          if (delta !== undefined && "toolUse" in delta && delta.toolUse !== undefined) {
            const sourceIndex = event.contentBlockDelta?.contentBlockIndex;
            const index = sourceIndex === undefined ? 0 : (indexes.get(sourceIndex) ?? 0);
            controller.enqueue(
              sse(
                chunk({
                  tool_calls: [{ index, function: { arguments: delta.toolUse.input ?? "" } }]
                })
              )
            );
          }
          if (
            delta !== undefined &&
            "reasoningContent" in delta &&
            delta.reasoningContent !== undefined
          ) {
            const reasoningIndex = event.contentBlockDelta?.contentBlockIndex ?? 0;
            const isThinkingDelta =
              ("text" in delta.reasoningContent &&
                typeof delta.reasoningContent.text === "string") ||
              ("signature" in delta.reasoningContent &&
                typeof delta.reasoningContent.signature === "string");
            if (isThinkingDelta && !reasoningIndexes.has(reasoningIndex)) {
              reasoningIndexes.add(reasoningIndex);
              controller.enqueue(
                sse(
                  chunk({
                    reasoning_details: [
                      {
                        type: "thinking",
                        index: reasoningIndex,
                        phase: "start"
                      }
                    ]
                  })
                )
              );
            }
            if (
              "text" in delta.reasoningContent &&
              typeof delta.reasoningContent.text === "string"
            ) {
              controller.enqueue(
                sse(
                  chunk({
                    reasoning: delta.reasoningContent.text,
                    reasoning_details: [
                      {
                        type: "thinking",
                        index: reasoningIndex,
                        phase: "delta",
                        thinking: delta.reasoningContent.text
                      }
                    ]
                  })
                )
              );
            } else if (
              "signature" in delta.reasoningContent &&
              typeof delta.reasoningContent.signature === "string"
            ) {
              controller.enqueue(
                sse(
                  chunk({
                    reasoning_details: [
                      {
                        type: "thinking",
                        index: reasoningIndex,
                        phase: "signature",
                        signature: delta.reasoningContent.signature
                      }
                    ]
                  })
                )
              );
            } else if (
              "redactedContent" in delta.reasoningContent &&
              delta.reasoningContent.redactedContent !== undefined
            ) {
              controller.enqueue(
                sse(
                  chunk({
                    reasoning_details: [
                      {
                        type: "redacted_thinking",
                        index: reasoningIndex,
                        phase: "block",
                        data: Buffer.from(delta.reasoningContent.redactedContent).toString("base64")
                      }
                    ]
                  })
                )
              );
            }
          }
          const stoppedIndex = event.contentBlockStop?.contentBlockIndex;
          if (stoppedIndex !== undefined && reasoningIndexes.has(stoppedIndex)) {
            controller.enqueue(
              sse(
                chunk({
                  reasoning_details: [
                    {
                      type: "thinking",
                      index: stoppedIndex,
                      phase: "stop"
                    }
                  ]
                })
              )
            );
          }
          if (event.messageStop !== undefined)
            controller.enqueue(sse(chunk({}, finishReason(event.messageStop.stopReason))));
          if (event.metadata?.usage !== undefined)
            controller.enqueue(sse(chunk({}, null, { usage: usage(event.metadata.usage) })));
        }
        controller.enqueue(sse("[DONE]"));
        controller.close();
      } catch (error) {
        if (signal?.aborted !== true) {
          controller.enqueue(
            sse({
              error: {
                type: "provider_error",
                message: error instanceof Error ? error.message : String(error)
              }
            })
          );
          controller.enqueue(sse("[DONE]"));
        }
        controller.close();
      }
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
export function errorResponse(error: unknown): Response {
  const metadata = record(record(error)?.$metadata);
  const status = typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : 502;
  return Response.json(
    {
      error: {
        type: "provider_error",
        message: error instanceof Error ? error.message : String(error)
      }
    },
    { status }
  );
}
