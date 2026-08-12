/**
 * OpenAI Responses wire types. The subset Codex and other Responses clients
 * send to `/v1/responses`. Translation lives in `responses-codec.ts`; HTTP
 * handling lives in `responses.ts`.
 */

import type { RouteKitReasoningEnvelope } from "./openai-chat-wire.js";

export type ResponsesContentPart = {
  type: string;
  text?: string;
  image_url?: string;
  [key: string]: unknown;
};

export type ResponsesInputItem =
  | {
      type?: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: string | ResponsesContentPart[];
    }
  | { type: "function_call"; call_id?: string; id?: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: unknown }
  | { type: "custom_tool_call"; call_id?: string; id?: string; name: string; input?: string }
  | { type: "custom_tool_call_output"; call_id: string; output: unknown }
  | {
      type: "reasoning";
      id?: string;
      summary?: unknown;
      content?: unknown;
      encrypted_content?: unknown;
    }
  | { type: string; [key: string]: unknown };

/** A tool declaration on a Responses request: a function tool (JSON-schema
 *  `parameters`), a freeform "custom" tool (a grammar/text `format` and raw
 *  string input — e.g. Codex's `apply_patch` for GPT-5-family models), or a
 *  *typed* tool identified only by its `type` (e.g. Codex's `tool_search` /
 *  `web_search` entries, which carry no `name`). */
export type ResponsesTool = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
  format?: { type?: string; syntax?: string; definition?: string };
  /** Typed tools declare who executes them ("client" for CLI-side tools). */
  execution?: string;
};

/**
 * Codex encodes "unset" as an explicit JSON `null` for several optional fields
 * (e.g. `"reasoning": null` whenever the selected model's metadata advertises
 * no reasoning levels — the default for many custom-provider models). Every
 * nullable field below must be read with a null-tolerant guard; reading
 * `.effort` off a null `reasoning` previously failed every such Codex turn.
 */
export type ResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; name?: string } | null;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  parallel_tool_calls?: boolean;
  /**
   * Codex serializes `reasoning: null` (not an absent key) for models whose
   * catalog metadata carries no reasoning level — every custom provider
   * member slug (e.g. `grok-4`, `deepseek`) resolves to Codex's fallback model
   * info, which has none. Null must translate as "no reasoning", never throw.
   */
  reasoning?: { effort?: string | null; [key: string]: unknown } | null;
  x_routekit?: RouteKitReasoningEnvelope | unknown;
  text?: {
    format?: {
      type?: string;
      name?: string;
      schema?: unknown;
      strict?: boolean;
      [key: string]: unknown;
    };
  } | null;
  previous_response_id?: string | null;
  truncation?: string | unknown;
  metadata?: Record<string, unknown> | null;
  include?: unknown[] | null;
  stream?: boolean;
};
