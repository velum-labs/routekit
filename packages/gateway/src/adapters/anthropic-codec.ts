/**
 * Anthropic Messages codec. Pure request/response translation between the
 * Anthropic Messages wire and the gateway's OpenAI Chat Completions core.
 * Streaming translation lives in `anthropic-stream.ts`; HTTP handling lives
 * in `anthropic.ts`.
 */

import type { Reasoning } from "@velum-labs/routekit-contracts/protocol-ir";
import { estimateTokens, randomId } from "@velum-labs/routekit-runtime";
import type { OpenAiChatResponse } from "../providers/protocol.js";
import { decodeToolResult } from "../providers/protocol.js";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicOutputConfig,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicThinking,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock
} from "./anthropic-wire.js";
import { droppedField } from "./dropped.js";
import {
  type AnthropicNativeContentBlock,
  type AnthropicRequestMetadata,
  anthropicReasoningDetailsOf,
  anthropicReasoningExtension,
  attachAnthropicMessageContent,
  attachAnthropicRequestMetadata,
  attachReasoningSelection,
  attachReasoningSelectionError,
  reasoningIndex
} from "./openai-chat-wire.js";
import type { ExecutedSearch, ServerToolLoopEvent } from "./server-tool-loop.js";

export type { AnthropicRequest } from "./anthropic-wire.js";

/**
 * Whether an Anthropic tool is *server-executed* (run by Anthropic's backend,
 * e.g. `web_search_20250305` / `code_execution_*`). Nothing behind this gateway
 * can execute those, so advertising them to the upstream model would only produce
 * calls nobody answers. Everything else — plain client tools (no `type` /
 * `custom`) and Anthropic-defined client tools (`bash_*`, `text_editor_*`,
 * `computer_*`), all of which the caller executes via ordinary `tool_use`
 * blocks — is projected through.
 */
export function isAnthropicServerTool(tool: { type?: string }): boolean {
  const type = tool.type ?? "";
  return type.startsWith("web_search") || type.startsWith("code_execution");
}

/** A server web search tool declaration (`web_search_20250305` et al.) — the
 *  one server tool the gateway can honor via its own web-search executor. */
export function isAnthropicWebSearchTool(tool: { type?: string }): boolean {
  return (tool.type ?? "").startsWith("web_search");
}

/** The name the gateway-executed web search tool is projected under chat-side. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web for current, factual information. The search runs server-side and " +
  "returns result text with source URLs. Use it when the answer depends on information " +
  "that may have changed since your training data.";

const WEB_SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "The web search query." }
  },
  required: ["query"],
  additionalProperties: false
} as const;

/** Options gating server-executed tool projection (on iff an executor exists). */
export type AnthropicTranslationOptions = { serverTools?: boolean };

/** Render an echoed `web_search_tool_result`'s content as a chat tool message.
 *  Bulky opaque fields (`encrypted_content`) are stripped; the upstream model
 *  only needs the urls/titles to remember what the search found. */
function webSearchResultText(content: unknown): string {
  const decoded = decodeToolResult("anthropic", content);
  const source = decoded.extensions?.[0]?.value;
  if (!Array.isArray(source)) return decoded.content;
  const results = source.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry as unknown;
    const { encrypted_content: _encrypted, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
  return JSON.stringify(results);
}

// ---- OpenAI shapes we read back ----

type OpenAiResponse = OpenAiChatResponse;

// ---- request translation ----

function systemText(system: AnthropicRequest["system"]): string {
  if (system == null) return "";
  if (typeof system === "string") return system;
  return system
    .map((block) =>
      block !== null && typeof block === "object" && typeof block.text === "string"
        ? block.text
        : ""
    )
    .join("\n");
}

function blockText(content: string | AnthropicContentBlock[] | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block !== null && typeof block === "object" && block.type === "text"
        ? (block as AnthropicTextBlock).text
        : ""
    )
    .join("");
}

function mapToolChoice(choice: NonNullable<AnthropicRequest["tool_choice"]>): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name ?? "" } };
    default: {
      const unreachable: never = choice.type;
      return unreachable;
    }
  }
}

function mapThinking(
  thinking: NonNullable<AnthropicThinking>,
  outputConfig: AnthropicOutputConfig | null | undefined
): string | undefined {
  if (thinking.type === "disabled") return undefined;
  const effort = outputConfig?.effort;
  return typeof effort === "string" && effort.length > 0 ? effort : undefined;
}

export function thinkingValidationError(body: AnthropicRequest): string | undefined {
  const thinking = body.thinking;
  if (thinking == null || thinking.type !== "enabled") return undefined;
  const budget = thinking.budget_tokens;
  if (!Number.isInteger(budget) || budget < 1_024) {
    return "thinking.budget_tokens must be an integer greater than or equal to 1024";
  }
  if (typeof body.max_tokens === "number" && budget >= body.max_tokens) {
    return `thinking.budget_tokens must be less than max_tokens (${body.max_tokens})`;
  }
  return undefined;
}

function toolResultContent(result: AnthropicToolResultBlock): string {
  const text = blockText(result.content);
  return result.is_error === true ? `[tool_error]\n${text}` : text;
}

/**
 * Translate an Anthropic Messages request to an OpenAI Chat Completions body.
 * The upstream model is always the backend's own model (Claude Code sends a
 * `claude-*` id the local server would not recognise); the requested id is
 * only echoed back in the response.
 */
export function anthropicToChat(
  body: AnthropicRequest,
  backendModel: string | undefined,
  options: AnthropicTranslationOptions = {}
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const system = systemText(body.system);
  if (system.length > 0) messages.push({ role: "system", content: system });

  for (const message of body.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    const imageParts: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResults: { id: string; content: string }[] = [];
    const nativeContent: AnthropicNativeContentBlock[] = [];
    let hasReplayableThinking = false;
    // Echoed gateway-executed (or genuinely provider-executed, in a resumed
    // session) web searches: `server_tool_use` + `web_search_tool_result`
    // blocks ride in the assistant message and round-trip losslessly.
    const serverToolUses: Record<string, unknown>[] = [];
    const serverToolResults: { id: string; content: string }[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          textParts.push((block as AnthropicTextBlock).text);
          nativeContent.push({ type: "text", text: (block as AnthropicTextBlock).text });
          break;
        case "image": {
          const source = (block as AnthropicImageBlock).source;
          imageParts.push({
            type: "image_url",
            image_url: { url: `data:${source.media_type};base64,${source.data}` }
          });
          break;
        }
        case "tool_use": {
          const tool = block as AnthropicToolUseBlock;
          toolCalls.push({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) }
          });
          nativeContent.push({
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: tool.input ?? {}
          });
          break;
        }
        case "tool_result": {
          const result = block as AnthropicToolResultBlock;
          toolResults.push({ id: result.tool_use_id, content: toolResultContent(result) });
          break;
        }
        case "server_tool_use": {
          const tool = block as unknown as AnthropicToolUseBlock;
          serverToolUses.push({
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) }
          });
          break;
        }
        case "web_search_tool_result": {
          const result = block as { tool_use_id?: string; content?: unknown };
          serverToolResults.push({
            id: result.tool_use_id ?? "",
            content: webSearchResultText(result.content)
          });
          break;
        }
        case "thinking": {
          const thinking = block as {
            thinking?: unknown;
            signature?: unknown;
          };
          // Only provider-issued non-empty signatures are safe to replay to
          // Anthropic. Synthetic thinking emitted for another provider uses an
          // empty signature and remains display-only.
          if (
            typeof thinking.thinking === "string" &&
            typeof thinking.signature === "string" &&
            thinking.signature.length > 0
          ) {
            nativeContent.push({
              type: "thinking",
              thinking: thinking.thinking,
              signature: thinking.signature
            });
            hasReplayableThinking = true;
          } else {
            droppedField("anthropic", "thinking", "message");
          }
          break;
        }
        case "redacted_thinking": {
          const redacted = block as { data?: unknown };
          if (typeof redacted.data === "string" && redacted.data.length > 0) {
            nativeContent.push({ type: "redacted_thinking", data: redacted.data });
            hasReplayableThinking = true;
          } else {
            droppedField("anthropic", "redacted_thinking", "message");
          }
          break;
        }
        default:
          droppedField("anthropic", block.type, "message");
          break;
      }
    }

    if (message.role === "assistant") {
      const text = textParts.join("");
      if (imageParts.length > 0) {
        droppedField("anthropic", "image", "assistant_message");
      }
      // Replay echoed server web searches as a chat tool exchange preceding
      // the assistant's answer, so the upstream model remembers what was
      // searched and found rather than blindly repeating it.
      if (serverToolUses.length > 0) {
        messages.push({ role: "assistant", content: null, tool_calls: serverToolUses });
        for (const use of serverToolUses) {
          const result = serverToolResults.find((entry) => entry.id === use.id);
          messages.push({
            role: "tool",
            tool_call_id: (use.id as string | undefined) ?? "",
            content: result?.content ?? "[web search results not retained]"
          });
        }
      }
      if (text.length > 0 || toolCalls.length > 0 || serverToolUses.length === 0) {
        const assistant: Record<string, unknown> = {
          role: "assistant",
          content: text.length > 0 ? text : null
        };
        if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
        if (hasReplayableThinking) attachAnthropicMessageContent(assistant, nativeContent);
        messages.push(assistant);
      }
      continue;
    }

    // user turn: tool results become standalone tool messages; remaining
    // text/images become a user message.
    for (const result of toolResults) {
      messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
    }
    const text = textParts.join("");
    if (imageParts.length > 0) {
      const parts: Record<string, unknown>[] = [];
      if (text.length > 0) parts.push({ type: "text", text });
      parts.push(...imageParts);
      messages.push({ role: "user", content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      messages.push({ role: "user", content: text });
    }
  }

  const chat: Record<string, unknown> = {
    model: backendModel ?? body.model ?? "",
    messages,
    stream: body.stream === true
  };
  // `max_completion_tokens`, not legacy `max_tokens`: OpenAI reasoning models
  // reject the latter, and the other dialect adapters already emit the modern
  // field (Claude Code always sends `max_tokens`, so this path is always hit).
  if (typeof body.max_tokens === "number") chat.max_completion_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.top_k === "number") chat.top_k = body.top_k;
  // Explicit nulls mean "unset" (see AnthropicRequest).
  if (body.metadata != null) droppedField("anthropic", "metadata");
  if (
    body.output_config != null &&
    Object.hasOwn(body.output_config, "effort") &&
    body.output_config.effort !== null &&
    (typeof body.output_config.effort !== "string" || body.output_config.effort.length === 0)
  ) {
    attachReasoningSelectionError(chat, "output_config.effort must be a non-empty string");
  }
  // `thinking: null` means "no extended thinking" — skip, never dereference
  // (same failure class as the Responses adapter's `reasoning: null`).
  if (body.thinking != null) {
    const reasoningEffort = mapThinking(body.thinking, body.output_config);
    if (body.thinking.type === "disabled") {
      attachReasoningSelection(chat, { mode: "disabled" });
    } else if (reasoningEffort !== undefined) {
      chat.reasoning_effort = reasoningEffort;
      attachReasoningSelection(chat, {
        mode: "effort",
        effort: reasoningEffort
      });
    } else if (body.thinking.type === "adaptive") {
      attachReasoningSelection(chat, { mode: "adaptive" });
    } else {
      attachReasoningSelection(chat, {
        mode: "budget",
        budgetTokens: body.thinking.budget_tokens
      });
    }
  }
  const metadata: AnthropicRequestMetadata = {
    ...(body.thinking != null ? { thinking: body.thinking } : {}),
    ...(body.output_config !== undefined ? { output_config: body.output_config } : {})
  };
  if (Object.keys(metadata).length > 0) {
    attachAnthropicRequestMetadata(chat, metadata);
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    chat.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // Web search is honorable when an executor exists (the server-tool loop
    // runs it); other server tools (`code_execution_*`) stay excluded.
    const honorWebSearch = options.serverTools === true;
    const excluded = body.tools.filter(
      (tool) => isAnthropicServerTool(tool) && !(honorWebSearch && isAnthropicWebSearchTool(tool))
    );
    if (excluded.length > 0) {
      for (const tool of excluded) {
        droppedField("anthropic", tool.name ?? tool.type ?? "server_tool", "tools");
      }
      if (process.env.ROUTEKIT_DEBUG) {
        process.stderr.write(
          `[routekit-debug] anthropic: excluding ${excluded.length} server-executed tool(s) ` +
            `from the request: ${excluded.map((tool) => tool.name).join(", ")}\n`
        );
      }
    }
    const tools = body.tools
      .filter(
        (tool) =>
          !isAnthropicServerTool(tool) && typeof tool.name === "string" && tool.name.length > 0
      )
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.input_schema ?? { type: "object", properties: {} }
        }
      }));
    if (
      honorWebSearch &&
      body.tools.some(isAnthropicWebSearchTool) &&
      !tools.some((tool) => tool.function.name === WEB_SEARCH_TOOL_NAME)
    ) {
      tools.push({
        type: "function",
        function: {
          name: WEB_SEARCH_TOOL_NAME,
          description: WEB_SEARCH_TOOL_DESCRIPTION,
          parameters: WEB_SEARCH_TOOL_PARAMETERS
        }
      });
    }
    if (tools.length > 0) chat.tools = tools;
  }
  if (body.tool_choice != null) {
    chat.tool_choice = mapToolChoice(body.tool_choice);
    if (body.tool_choice.disable_parallel_tool_use === true) chat.parallel_tool_calls = false;
  }
  if (body.stream === true) chat.stream_options = { include_usage: true };
  return chat;
}

// ---- response translation ----

export function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case "stop":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** The native Anthropic blocks for one gateway-executed web search: the
 *  `server_tool_use` and its `web_search_tool_result`. Anthropic-executor
 *  results pass through verbatim; other executors build result blocks
 *  from their citations. */
function executedSearchBlocks(search: ExecutedSearch): Record<string, unknown>[] {
  const resultBlocks = search.result?.extensions?.find(
    (extension) => extension.namespace === "anthropic.web-search-results"
  )?.value;
  const resultContent: unknown =
    search.status !== "completed"
      ? { type: "web_search_tool_result_error", error_code: "unavailable" }
      : Array.isArray(resultBlocks) && resultBlocks.length > 0
        ? resultBlocks
        : (search.result?.citations ?? []).map((citation) => ({
            type: "web_search_result",
            url: citation.url,
            ...(citation.title !== undefined ? { title: citation.title } : {})
          }));
  return [
    {
      type: "server_tool_use",
      id: search.itemId,
      name: WEB_SEARCH_TOOL_NAME,
      input: { query: search.query }
    },
    { type: "web_search_tool_result", tool_use_id: search.itemId, content: resultContent }
  ];
}

export function chatToAnthropicMessage(
  openai: OpenAiResponse,
  model: string,
  searches: readonly ExecutedSearch[] = [],
  events?: readonly ServerToolLoopEvent[]
): Record<string, unknown> {
  const choice = openai.choices?.[0];
  const message = choice?.message;
  const content: Record<string, unknown>[] = [];

  const nativeReasoning = anthropicReasoningDetailsOf(message?.reasoning_details, "message").sort(
    (a, b) => reasoningIndex(a) - reasoningIndex(b)
  );
  const appendNativeReasoning = (details: readonly Reasoning[]): void => {
    for (const detail of details) {
      const metadata = anthropicReasoningExtension(detail);
      if (metadata?.redacted !== true) {
        content.push({
          type: "thinking",
          thinking: detail.text ?? "",
          signature: metadata?.signature ?? ""
        });
      } else {
        content.push({ type: "redacted_thinking", data: detail.encryptedContent ?? "" });
      }
    }
  };

  // Gateway-executed steps precede the terminal model step. Preserve their
  // signed/redacted reasoning in exact step order around search blocks.
  if (events !== undefined) {
    for (const event of events) {
      if (event.kind === "reasoning") {
        appendNativeReasoning(anthropicReasoningDetailsOf(event.details, "message"));
      } else {
        content.push(...executedSearchBlocks(event.search));
      }
    }
  } else {
    for (const search of searches) content.push(...executedSearchBlocks(search));
  }
  appendNativeReasoning(nativeReasoning);
  const rawReasoning =
    typeof message?.reasoning === "string" && message.reasoning.length > 0 ? message.reasoning : "";
  const narration =
    typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
      ? message.reasoning_content.replace(/\*\*/g, "")
      : "";
  if (nativeReasoning.length === 0 && rawReasoning.length > 0) {
    // Generic providers cannot produce an Anthropic-verifiable signature.
    // The empty marker makes the block displayable; ingress deliberately
    // refuses to replay it as native signed history.
    content.push({
      type: "thinking",
      thinking: rawReasoning,
      signature: ""
    });
  }
  if (narration.length > 0) {
    content.push({ type: "thinking", thinking: narration, signature: "" });
  }

  const text = typeof message?.content === "string" ? message.content : "";
  if (text.length > 0) content.push({ type: "text", text });

  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      let input: unknown = {};
      const args = call.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        try {
          input = JSON.parse(args);
        } catch {
          input = {};
        }
      }
      content.push({
        type: "tool_use",
        id: call.id ?? `toolu_${randomId()}`,
        name: call.function?.name ?? "",
        input
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const response: Record<string, unknown> = {
    id: openai.id !== undefined ? `msg_${openai.id}` : `msg_${randomId()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason:
      typeof choice?.anthropic_stop_reason === "string"
        ? choice.anthropic_stop_reason
        : mapStopReason(choice?.finish_reason),
    stop_sequence:
      typeof choice?.anthropic_stop_sequence === "string" ? choice.anthropic_stop_sequence : null
  };
  if (openai.usage !== undefined) {
    response.usage = {
      ...(openai.usage.inputTokens !== undefined ? { input_tokens: openai.usage.inputTokens } : {}),
      ...(openai.usage.outputTokens !== undefined
        ? { output_tokens: openai.usage.outputTokens }
        : {})
    };
  }
  return response;
}

// ---- token counting + discovery ----

export function countTokensEstimate(body: AnthropicRequest): number {
  const parts: string[] = [systemText(body.system)];
  for (const message of body.messages) parts.push(blockText(message.content));
  return estimateTokens(...parts);
}
