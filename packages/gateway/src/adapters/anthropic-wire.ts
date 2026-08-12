/**
 * Anthropic Messages wire types. The subset Claude Code and other Messages
 * clients send to `/v1/messages`. Translation lives in `anthropic-codec.ts`;
 * HTTP handling lives in `anthropic.ts`.
 */

import type { AnthropicThinkingConfig } from "./openai-chat-wire.js";

export type AnthropicTextBlock = { type: "text"; text: string };
export type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
export type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
};
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

export type AnthropicThinking = AnthropicThinkingConfig | null;
export type AnthropicOutputConfig = {
  effort?: string | null;
  [key: string]: unknown;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

/**
 * Optional object fields tolerate an explicit JSON `null` (some clients encode
 * "unset" that way — Codex does on the Responses wire); reads must use
 * null-tolerant guards so a null never crashes the turn.
 */
export type AnthropicRequest = {
  model?: string;
  system?: string | AnthropicTextBlock[] | null;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: AnthropicThinking | null;
  output_config?: AnthropicOutputConfig | null;
  metadata?: Record<string, unknown> | null;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ type?: string; name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
    disable_parallel_tool_use?: boolean;
  } | null;
};
