import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary
} from "@aws-sdk/client-bedrock";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamOutput,
  type Message,
  type SystemContentBlock,
  type Tool
} from "@aws-sdk/client-bedrock-runtime";
import { randomId } from "@velum-labs/routekit-runtime";

type BedrockDocument = NonNullable<ConverseCommandInput["additionalModelRequestFields"]>;

import { OpenAiBackend, type BackendRequestOptions } from "./backend.js";
import type { DiscoveredModel, ProviderSource } from "./provider-source.js";
import {
  anthropicReasoningDetailsOf,
  reasoningSelectionOf,
  withoutRouteKitExtensions,
  type AnthropicReasoningDetail,
  type CanonicalReasoningDetail
} from "./adapters/openai-chat-wire.js";

export type BedrockControlClient = Pick<BedrockClient, "send">;
export type BedrockRuntime = Pick<BedrockRuntimeClient, "send">;
export type BedrockMantleBackend = Pick<OpenAiBackend, "chat" | "responses">;
export type BedrockProviderSourceOptions = {
  controlClient?: BedrockControlClient;
  runtimeClient?: BedrockRuntime;
  env?: NodeJS.ProcessEnv;
  mantleBackend?: BedrockMantleBackend;
};

export const BEDROCK_OPENAI_ALLOWLIST = [
  "openai.gpt-5.4",
  "openai.gpt-5.5",
  "openai.gpt-5.6-sol",
  "openai.gpt-5.6-terra",
  "openai.gpt-5.6-luna"
] as const;

const BEDROCK_OPENAI_MODEL = /^(?:(?:us|eu|global)\.)?openai\.gpt-/;

export function isBedrockOpenAiModel(modelId: string): boolean {
  return BEDROCK_OPENAI_MODEL.test(modelId);
}

/**
 * Codex talks to RouteKit as OpenAI-compatible, so it sends OpenAI/Codex
 * protocol items that Bedrock mantle rejects. Native OpenAI is unchanged.
 *
 * - `search_content_types` on `web_search*`
 * - `agent_message` (Codex 0.147 subagent handoff)
 * - `encrypted_content` content parts (same 400 as `agent_message`)
 * - `compaction` / `reasoning` encrypted blobs without `rsn_` / `smry_`
 */
export function sanitizeBedrockMantleRequestBody(body: unknown): unknown {
  const payload = record(body);
  if (payload === undefined) return body;
  let next: Record<string, unknown> = payload;
  let changed = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.map((tool) => {
      const entry = record(tool);
      if (entry === undefined) return tool;
      const type = typeof entry.type === "string" ? entry.type : "";
      if (!type.startsWith("web_search") || !("search_content_types" in entry)) return tool;
      changed = true;
      const { search_content_types: _ignored, ...rest } = entry;
      return rest;
    });
    if (changed) next = { ...next, tools };
  }

  if (Array.isArray(payload.input)) {
    const input: unknown[] = [];
    let inputChanged = false;
    for (const item of payload.input) {
      const sanitized = sanitizeBedrockMantleInputItem(item);
      if (sanitized === undefined) {
        inputChanged = true;
        continue;
      }
      if (sanitized !== item) inputChanged = true;
      input.push(sanitized);
    }
    if (inputChanged) {
      changed = true;
      next = { ...next, input };
    }
  }

  return changed ? next : body;
}

function recognizedEncryptedPrefix(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith("rsn_") || value.startsWith("smry_"));
}

function sanitizeBedrockMantleContent(content: unknown): { content: unknown; changed: boolean } {
  if (!Array.isArray(content)) return { content, changed: false };
  const parts = content.filter((part) => record(part)?.type !== "encrypted_content");
  return { content: parts, changed: parts.length !== content.length };
}

function sanitizeBedrockMantleInputItem(item: unknown): unknown {
  const entry = record(item);
  if (entry === undefined) return item;
  const type = typeof entry.type === "string" ? entry.type : "";

  if (type === "compaction" && "encrypted_content" in entry && !recognizedEncryptedPrefix(entry.encrypted_content)) {
    return undefined;
  }

  if (type === "agent_message") {
    const { content } = sanitizeBedrockMantleContent(entry.content);
    return { type: "message", role: "user", content };
  }

  let next = entry;
  let changed = false;
  if (Array.isArray(entry.content)) {
    const sanitized = sanitizeBedrockMantleContent(entry.content);
    if (sanitized.changed) {
      next = { ...next, content: sanitized.content };
      changed = true;
    }
  }
  if (
    type === "reasoning" &&
    "encrypted_content" in next &&
    !recognizedEncryptedPrefix(next.encrypted_content)
  ) {
    const { encrypted_content: _ignored, ...rest } = next;
    next = rest;
    changed = true;
  }
  return changed ? next : item;
}

function mantleApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.AWS_BEARER_TOKEN_BEDROCK ?? env.BEDROCK_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function mantleRegion(env: NodeJS.ProcessEnv): string | undefined {
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  return typeof region === "string" && region.length > 0 ? region : undefined;
}

function mantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

function bedrockOpenAiNativeId(modelId: string): string {
  return modelId.replace(/^(?:us|eu|global)\./, "");
}

function bedrockOpenAiReasoning(modelId: string): DiscoveredModel["reasoning"] {
  const native = bedrockOpenAiNativeId(modelId).replace(/^openai\./, "");
  if (/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(native)) {
    return {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultEffort: "medium",
      wireShape: "openai-responses",
      provenance: "builtin"
    };
  }
  if (/^gpt-5\.(?:4|5)(?:-\d{4}-\d{2}-\d{2})?$/.test(native)) {
    return {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
      wireShape: "openai-responses",
      provenance: "builtin"
    };
  }
  return {
    status: "supported",
    wireShape: "openai-responses",
    provenance: "builtin"
  };
}

function bedrockOpenAiDiscoveredModel(id: string): DiscoveredModel {
  return {
    id,
    metadata: {
      architecture: {
        modality: "text+image->text",
        inputModalities: ["text", "image"],
        outputModalities: ["text"]
      },
      supportedParameters: ["tools", "tool_choice"],
      provenance: "route"
    },
    reasoning: bedrockOpenAiReasoning(id),
    capabilities: { streaming: "supported" }
  };
}

type ChatMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  reasoning_details?: CanonicalReasoningDetail[];
};
type ChatBody = {
  model?: unknown;
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
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
    ? value as Record<string, unknown>
    : undefined;
}
function anthropicFoundationModel(model: FoundationModelSummary): boolean {
  return model.providerName?.toLowerCase() === "anthropic" &&
    model.modelLifecycle?.status === "ACTIVE" &&
    typeof model.modelId === "string" && model.modelId.length > 0;
}
function foundationIdFromArn(arn: string | undefined): string | undefined {
  if (arn === undefined) return undefined;
  const marker = ":foundation-model/";
  const index = arn.indexOf(marker);
  return index < 0 ? undefined : arn.slice(index + marker.length);
}
function activeAnthropicProfile(profile: InferenceProfileSummary, anthropicModels: ReadonlySet<string>): boolean {
  return profile.status === "ACTIVE" &&
    typeof profile.inferenceProfileId === "string" && profile.inferenceProfileId.length > 0 &&
    (profile.models ?? []).some((model) => {
      const id = foundationIdFromArn(model.modelArn);
      return id !== undefined && anthropicModels.has(id);
    });
}
function isOpusFiveModel(modelId: string): boolean {
  return /(?:^|\.)anthropic\.claude-opus-5$/.test(modelId);
}
function inferenceProfilePriority(profileId: string): number {
  if (profileId.startsWith("us.")) return 0;
  if (profileId.startsWith("global.")) return 1;
  return 2;
}
function preferredInferenceProfile(
  current: string | undefined,
  candidate: string
): string {
  if (current === undefined) return candidate;
  return inferenceProfilePriority(candidate) < inferenceProfilePriority(current)
    ? candidate
    : current;
}
function bedrockReasoningCapabilities(
  modelId: string | undefined
): DiscoveredModel["reasoning"] {
  if (modelId === undefined || !isOpusFiveModel(modelId)) return undefined;
  return {
    status: "supported",
    efforts: ["low", "medium", "high", "max"].map((id) => ({ id })),
    adaptive: true,
    wireShape: "bedrock-converse",
    provenance: "builtin"
  };
}
function bedrockMetadata(model: FoundationModelSummary): DiscoveredModel["metadata"] {
  const inputModalities = (model.inputModalities ?? []).map((value) => value.toLowerCase());
  const outputModalities = (model.outputModalities ?? []).map((value) => value.toLowerCase());
  const inputs = inputModalities.length > 0 ? inputModalities : ["text"];
  const outputs = outputModalities.length > 0 ? outputModalities : ["text"];
  return {
    architecture: {
      modality: `${inputs.join("+")}->${outputs.join("+")}`,
      inputModalities: inputs,
      outputModalities: outputs
    },
    supportedParameters: ["tools", "tool_choice"],
    provenance:
      inputModalities.length > 0 || outputModalities.length > 0 ? "provider" : "route"
  };
}
function bedrockDiscoveredModel(
  id: string,
  model: FoundationModelSummary
): DiscoveredModel {
  const reasoning = bedrockReasoningCapabilities(model.modelId);
  return {
    id,
    metadata: bedrockMetadata(model),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(model.responseStreamingSupported !== undefined
      ? {
          capabilities: {
            streaming: model.responseStreamingSupported ? "supported" : "unsupported"
          }
        }
      : {})
  };
}
function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const item = record(part);
    return typeof item?.text === "string" ? [item.text] : [];
  }).join("");
}
function imageBlock(part: Record<string, unknown>): ContentBlock | undefined {
  const imageUrl = typeof part.image_url === "string" ? part.image_url : record(part.image_url)?.url;
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
    .sort((left, right) => left.index - right.index)
    .map((detail): ContentBlock =>
      detail.type === "redacted_thinking"
        ? { reasoningContent: { redactedContent: Uint8Array.from(Buffer.from(detail.data, "base64")) } }
        : { reasoningContent: { reasoningText: {
            text: detail.thinking ?? "",
            ...(detail.signature !== undefined ? { signature: detail.signature } : {})
          } } }
    );
}

function messageContent(message: ChatMessage): ContentBlock[] {
  const blocks: ContentBlock[] = message.role === "assistant"
    ? bedrockReasoningBlocks(message.reasoning_details)
    : [];
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
    try { input = JSON.parse(call.function?.arguments ?? "{}"); } catch { input = { raw: call.function?.arguments ?? "" }; }
    blocks.push({ toolUse: {
      toolUseId: call.id ?? randomId(12, "toolu_"),
      name: call.function?.name ?? "tool",
      input: input as BedrockDocument
    } });
  }
  return blocks;
}
function bedrockMessages(body: ChatBody): { system?: SystemContentBlock[]; messages: Message[] } {
  const systemText = (body.messages ?? []).filter((message) => message.role === "system")
    .map((message) => textParts(message.content)).filter((text) => text.length > 0);
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
        content.push({ toolResult: {
          toolUseId: toolMessage.tool_call_id ?? "",
          content: [{ text: textParts(toolMessage.content) }]
        } });
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
    return [{ toolSpec: {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      inputSchema: { json: (record(fn.parameters) ?? {}) as BedrockDocument }
    } }];
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
  if (typeof canonical.model !== "string" || canonical.model.length === 0) throw new Error("Bedrock chat requires a model");
  const translated = bedrockMessages(canonical);
  const tools = canonical.tool_choice === "none" ? undefined : bedrockTools(canonical);
  const maxTokens = typeof canonical.max_completion_tokens === "number" ? canonical.max_completion_tokens : canonical.max_tokens;
  const stops = typeof canonical.stop === "string" ? [canonical.stop] : Array.isArray(canonical.stop)
    ? canonical.stop.filter((value): value is string => typeof value === "string") : undefined;
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
      ? {
          ...(thinking as Record<string, BedrockDocument> | undefined),
          ...(typeof canonical.top_k === "number" ? { top_k: canonical.top_k } : {})
        } as BedrockDocument
      : undefined;
  return {
    modelId: canonical.model,
    ...translated,
    ...(tools !== undefined ? { toolConfig: { tools, toolChoice: toolChoice(canonical.tool_choice) } } : {}),
    ...(typeof maxTokens === "number" || typeof canonical.temperature === "number" ||
      typeof canonical.top_p === "number" || stops !== undefined ? { inferenceConfig: {
        ...(typeof maxTokens === "number" ? { maxTokens } : {}),
        ...(typeof canonical.temperature === "number" ? { temperature: canonical.temperature } : {}),
        ...(typeof canonical.top_p === "number" ? { topP: canonical.top_p } : {}),
        ...(stops !== undefined ? { stopSequences: stops } : {})
      } } : {}),
    ...(additionalModelRequestFields !== undefined ? { additionalModelRequestFields } : {})
  };
}
function finishReason(reason: string | undefined): string {
  switch (reason) {
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "content_filtered":
    case "guardrail_intervened": return "content_filter";
    default: return "stop";
  }
}
function usage(value: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const prompt = value.inputTokens ?? 0;
  const completion = value.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: value.totalTokens ?? prompt + completion };
}
function outputMessage(output: ConverseCommandOutput): Record<string, unknown> {
  const content = output.output?.message?.content ?? [];
  let text = "";
  let reasoning = "";
  const reasoningDetails: AnthropicReasoningDetail[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const [index, block] of content.entries()) {
    if ("text" in block && typeof block.text === "string") text += block.text;
    if ("toolUse" in block && block.toolUse !== undefined) toolCalls.push({
      id: block.toolUse.toolUseId, type: "function",
      function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input ?? {}) }
    });
    if ("reasoningContent" in block && block.reasoningContent !== undefined) {
      if ("reasoningText" in block.reasoningContent && block.reasoningContent.reasoningText !== undefined) {
        const reasoningText = block.reasoningContent.reasoningText;
        reasoning += reasoningText.text ?? "";
        reasoningDetails.push({
          type: "thinking",
          index,
          thinking: reasoningText.text ?? "",
          signature: reasoningText.signature ?? ""
        });
      } else if ("redactedContent" in block.reasoningContent && block.reasoningContent.redactedContent !== undefined) {
        reasoningDetails.push({
          type: "redacted_thinking",
          index,
          data: Buffer.from(block.reasoningContent.redactedContent).toString("base64")
        });
      }
    }
  }
  return { role: "assistant", content: text,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
}
export function fromBedrockConverseOutput(output: ConverseCommandOutput, model: string): Record<string, unknown> {
  return {
    id: output.$metadata.requestId ?? randomId(18, "chatcmpl_"), object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: outputMessage(output), finish_reason: finishReason(output.stopReason) }],
    ...(usage(output.usage) !== undefined ? { usage: usage(output.usage) } : {})
  };
}
function streamError(event: ConverseStreamOutput): Error | undefined {
  for (const key of ["internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException"] as const) {
    const value = event[key];
    if (value !== undefined) return new Error(value.message ?? `Bedrock stream ${key}`);
  }
  return undefined;
}
function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}
function streamResponse(stream: AsyncIterable<ConverseStreamOutput>, model: string, signal?: AbortSignal): Response {
  const id = randomId(18, "chatcmpl_");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReasonValue: string | null = null, extra: Record<string, unknown> = {}) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finishReasonValue }], ...extra
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const indexes = new Map<number, number>();
      const reasoningIndexes = new Set<number>();
      let nextTool = 0;
      try {
        controller.enqueue(sse(chunk({ role: "assistant" })));
        for await (const event of stream) {
          if (signal?.aborted === true) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const error = streamError(event);
          if (error !== undefined) throw error;
          if (event.contentBlockStart?.start?.toolUse !== undefined) {
            const sourceIndex = event.contentBlockStart.contentBlockIndex;
            const index = nextTool++;
            if (sourceIndex !== undefined) indexes.set(sourceIndex, index);
            const tool = event.contentBlockStart.start.toolUse;
            controller.enqueue(sse(chunk({ tool_calls: [{ index, id: tool.toolUseId, type: "function", function: { name: tool.name, arguments: "" } }] })));
          }
          const delta = event.contentBlockDelta?.delta;
          if (delta !== undefined && "text" in delta && typeof delta.text === "string") controller.enqueue(sse(chunk({ content: delta.text })));
          if (delta !== undefined && "toolUse" in delta && delta.toolUse !== undefined) {
            const sourceIndex = event.contentBlockDelta?.contentBlockIndex;
            const index = sourceIndex === undefined ? 0 : indexes.get(sourceIndex) ?? 0;
            controller.enqueue(sse(chunk({ tool_calls: [{ index, function: { arguments: delta.toolUse.input ?? "" } }] })));
          }
          if (delta !== undefined && "reasoningContent" in delta && delta.reasoningContent !== undefined) {
            const reasoningIndex = event.contentBlockDelta?.contentBlockIndex ?? 0;
            const isThinkingDelta =
              ("text" in delta.reasoningContent && typeof delta.reasoningContent.text === "string") ||
              ("signature" in delta.reasoningContent && typeof delta.reasoningContent.signature === "string");
            if (isThinkingDelta && !reasoningIndexes.has(reasoningIndex)) {
              reasoningIndexes.add(reasoningIndex);
              controller.enqueue(sse(chunk({ reasoning_details: [{
                type: "thinking", index: reasoningIndex, phase: "start"
              }] })));
            }
            if ("text" in delta.reasoningContent && typeof delta.reasoningContent.text === "string") {
              controller.enqueue(sse(chunk({
                reasoning: delta.reasoningContent.text,
                reasoning_details: [{
                  type: "thinking", index: reasoningIndex, phase: "delta",
                  thinking: delta.reasoningContent.text
                }]
              })));
            } else if ("signature" in delta.reasoningContent && typeof delta.reasoningContent.signature === "string") {
              controller.enqueue(sse(chunk({ reasoning_details: [{
                type: "thinking", index: reasoningIndex, phase: "signature",
                signature: delta.reasoningContent.signature
              }] })));
            } else if ("redactedContent" in delta.reasoningContent && delta.reasoningContent.redactedContent !== undefined) {
              controller.enqueue(sse(chunk({ reasoning_details: [{
                type: "redacted_thinking", index: reasoningIndex, phase: "block",
                data: Buffer.from(delta.reasoningContent.redactedContent).toString("base64")
              }] })));
            }
          }
          const stoppedIndex = event.contentBlockStop?.contentBlockIndex;
          if (stoppedIndex !== undefined && reasoningIndexes.has(stoppedIndex)) {
            controller.enqueue(sse(chunk({ reasoning_details: [{
              type: "thinking", index: stoppedIndex, phase: "stop"
            }] })));
          }
          if (event.messageStop !== undefined) controller.enqueue(sse(chunk({}, finishReason(event.messageStop.stopReason))));
          if (event.metadata?.usage !== undefined) controller.enqueue(sse(chunk({}, null, { usage: usage(event.metadata.usage) })));
        }
        controller.enqueue(sse("[DONE]"));
        controller.close();
      } catch (error) {
        if (signal?.aborted !== true) {
          controller.enqueue(sse({ error: { type: "provider_error", message: error instanceof Error ? error.message : String(error) } }));
          controller.enqueue(sse("[DONE]"));
        }
        controller.close();
      }
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
function errorResponse(error: unknown): Response {
  const metadata = record(record(error)?.$metadata);
  const status = typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : 502;
  return Response.json({ error: { type: "provider_error", message: error instanceof Error ? error.message : String(error) } }, { status });
}

export class BedrockProviderSource implements ProviderSource {
  readonly sourceId = "bedrock" as const;
  readonly #control: BedrockControlClient;
  readonly #runtime: BedrockRuntime;
  readonly #env: NodeJS.ProcessEnv;
  readonly #injectedMantle: BedrockMantleBackend | undefined;
  #mantle: BedrockMantleBackend | undefined;
  readonly #inferenceProfilesByFoundation = new Map<string, string>();
  constructor(options: BedrockProviderSourceOptions = {}) {
    this.#control = options.controlClient ?? new BedrockClient({});
    this.#runtime = options.runtimeClient ?? new BedrockRuntimeClient({});
    this.#env = options.env ?? process.env;
    this.#injectedMantle = options.mantleBackend;
  }
  #mantleBackend(): BedrockMantleBackend | undefined {
    if (this.#injectedMantle !== undefined) return this.#injectedMantle;
    if (this.#mantle !== undefined) return this.#mantle;
    const apiKey = mantleApiKey(this.#env);
    const region = mantleRegion(this.#env);
    if (apiKey === undefined || region === undefined) return undefined;
    this.#mantle = new OpenAiBackend({
      baseUrl: mantleBaseUrl(region),
      apiKey
    });
    return this.#mantle;
  }
  #missingMantleResponse(): Response {
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "Bedrock OpenAI models require AWS_BEARER_TOKEN_BEDROCK and AWS_REGION"
        }
      },
      { status: 400 }
    );
  }
  async discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
    this.#inferenceProfilesByFoundation.clear();
    const abort = signal === undefined ? undefined : { abortSignal: signal };
    let discovered = new Map<string, DiscoveredModel>();
    try {
      const foundation = await this.#control.send(new ListFoundationModelsCommand({ byProvider: "Anthropic" }), abort);
      const foundations = (foundation.modelSummaries ?? []).filter(anthropicFoundationModel);
      const byId = new Map(foundations.map((model) => [model.modelId!, model]));
      const ids = new Set(byId.keys());
      discovered = new Map(
        foundations.map((model) => [
          model.modelId!,
          bedrockDiscoveredModel(model.modelId!, model)
        ])
      );
      let nextToken: string | undefined;
      do {
        const profiles = await this.#control.send(new ListInferenceProfilesCommand({ ...(nextToken !== undefined ? { nextToken } : {}) }), abort);
        for (const profile of profiles.inferenceProfileSummaries ?? []) {
          if (!activeAnthropicProfile(profile, ids)) continue;
          const backingId = (profile.models ?? [])
            .map((model) => foundationIdFromArn(model.modelArn))
            .find((id): id is string => id !== undefined && ids.has(id));
          if (backingId !== undefined) {
            this.#inferenceProfilesByFoundation.set(
              backingId,
              preferredInferenceProfile(
                this.#inferenceProfilesByFoundation.get(backingId),
                profile.inferenceProfileId!
              )
            );
            discovered.set(
              profile.inferenceProfileId!,
              bedrockDiscoveredModel(profile.inferenceProfileId!, byId.get(backingId)!)
            );
          }
        }
        nextToken = profiles.nextToken;
      } while (nextToken !== undefined && nextToken.length > 0);
    } catch (error) {
      if (mantleApiKey(this.#env) === undefined) throw error;
      discovered = new Map();
      this.#inferenceProfilesByFoundation.clear();
    }
    if (mantleApiKey(this.#env) !== undefined) {
      for (const id of BEDROCK_OPENAI_ALLOWLIST) {
        discovered.set(id, bedrockOpenAiDiscoveredModel(id));
      }
    }
    if (discovered.size === 0) throw new Error("model discovery returned no active Anthropic Bedrock models");
    return [...discovered.values()];
  }
  supportsResponses(model: string): boolean {
    return isBedrockOpenAiModel(model);
  }
  async responses(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const requestedModel = record(body)?.model;
    const model = typeof requestedModel === "string" ? requestedModel : "";
    if (!isBedrockOpenAiModel(model)) {
      return Response.json(
        { error: { type: "not_supported", message: "native Responses egress is not supported" } },
        { status: 501 }
      );
    }
    const backend = this.#mantleBackend();
    if (backend === undefined) return this.#missingMantleResponse();
    return backend.responses(sanitizeBedrockMantleRequestBody(body), signal, options);
  }
  async chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): Promise<Response> {
    const requestedModel = record(body)?.model;
    if (typeof requestedModel === "string" && isBedrockOpenAiModel(requestedModel)) {
      const backend = this.#mantleBackend();
      if (backend === undefined) return this.#missingMantleResponse();
      return backend.chat(sanitizeBedrockMantleRequestBody(body), signal, options);
    }
    let input: ConverseCommandInput;
    try { input = toBedrockConverseInput(body); } catch (error) {
      return Response.json(
        { error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) } },
        { status: 400 }
      );
    }
    const stream = record(body)?.stream === true;
    const modelId = input.modelId;
    if (modelId === undefined) return errorResponse(new Error("Bedrock chat requires a model"));
    const runtimeModelId =
      modelId === "anthropic.claude-opus-5"
        ? this.#inferenceProfilesByFoundation.get(modelId) ?? modelId
        : modelId;
    const runtimeInput =
      runtimeModelId === modelId ? input : { ...input, modelId: runtimeModelId };
    try {
      if (stream) {
        const output = await this.#runtime.send(new ConverseStreamCommand(runtimeInput), signal === undefined ? undefined : { abortSignal: signal });
        if (output.stream === undefined) throw new Error("Bedrock returned no response stream");
        return streamResponse(output.stream, modelId, signal);
      }
      const output = await this.#runtime.send(new ConverseCommand(runtimeInput), signal === undefined ? undefined : { abortSignal: signal });
      return Response.json(fromBedrockConverseOutput(output, modelId));
    } catch (error) { return errorResponse(error); }
  }
  embeddings(): Promise<Response> {
    return Promise.resolve(Response.json({ error: { type: "not_implemented", message: "Bedrock embeddings are not supported" } }, { status: 501 }));
  }
  reasoningCapabilities(model?: string): DiscoveredModel["reasoning"] {
    if (model !== undefined && isBedrockOpenAiModel(model)) {
      return bedrockOpenAiReasoning(model);
    }
    const known = bedrockReasoningCapabilities(model);
    if (known !== undefined) return known;
    return {
      status: "unknown",
      wireShape: "bedrock-converse",
      provenance: "provider"
    };
  }
  close(): void {
    (this.#control as { destroy?: () => void }).destroy?.();
    (this.#runtime as { destroy?: () => void }).destroy?.();
  }
}
