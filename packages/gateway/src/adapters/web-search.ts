/**
 * Gateway-side web search execution (server-tool parity).
 *
 * `web_search` is a *server-executed* tool: callers (Codex, Claude Code, API
 * clients) declare it but never run it — on the real provider APIs the
 * backend searches mid-turn. Nothing behind this gateway can do that, so the
 * gateway becomes the server: the dialect adapters project the tool to the
 * upstream model, and when it calls the tool the server-tool loop executes the
 * search here by delegating to a real provider's native web search in a
 * one-shot, buffered side call.
 *
 * Each dialect prefers its own provider (result and citation shapes match
 * what the caller's provider would have produced), falling back to the other
 * provider when only one key is available. With no key at all the feature is
 * off and the adapters keep their honest-drop behavior.
 */

import type { ToolResult } from "@velum-labs/routekit-contracts/protocol-ir";
import { withDeadline } from "@velum-labs/routekit-runtime";
import {
  decodeAnthropicWebSearchResult,
  decodeOpenAiWebSearchResult
} from "../provider-protocol.js";

export type WebSearchExecutor = {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  search(query: string, signal?: AbortSignal): Promise<ToolResult>;
};

export type WebSearchDialect = "responses" | "anthropic";

/** Hard ceiling on gateway-executed searches within one caller turn. */
export const MAX_WEB_SEARCHES_PER_TURN = 8;

/** Per-search wall clock before the delegated call is aborted. */
const SEARCH_TIMEOUT_MS = 90_000;

const OPENAI_DEFAULT_MODEL = "gpt-5.5";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";

const SEARCH_PROMPT_PREFIX =
  "Search the web and report what you find, including source URLs. " +
  "Be factual and concise; do not editorialize. Query:\n\n";

function searchError(provider: string, status: number, detail: string): Error {
  return new Error(`web search via ${provider} failed (${status}): ${detail.slice(0, 500)}`);
}

// ---- OpenAI executor (native `web_search` on /v1/responses) ----

function openAiExecutor(
  apiKey: string,
  env: Record<string, string | undefined>
): WebSearchExecutor {
  const model = env.ROUTEKIT_WEB_SEARCH_OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL;
  const baseUrl = env.ROUTEKIT_WEB_SEARCH_OPENAI_URL ?? "https://api.openai.com/v1";
  return {
    provider: "openai",
    model,
    async search(query, signal) {
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          reasoning: { effort: "low" },
          tools: [{ type: "web_search" }],
          tool_choice: "auto",
          input: `${SEARCH_PROMPT_PREFIX}${query}`
        }),
        signal: withDeadline(signal, SEARCH_TIMEOUT_MS)
      });
      if (!response.ok) throw searchError("openai", response.status, await response.text());
      return decodeOpenAiWebSearchResult(await response.json());
    }
  };
}

// ---- Anthropic executor (native `web_search_20250305` on /v1/messages) ----

function anthropicExecutor(
  apiKey: string,
  env: Record<string, string | undefined>
): WebSearchExecutor {
  const model = env.ROUTEKIT_WEB_SEARCH_ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL;
  const baseUrl = env.ROUTEKIT_WEB_SEARCH_ANTHROPIC_URL ?? "https://api.anthropic.com/v1";
  return {
    provider: "anthropic",
    model,
    async search(query, signal) {
      const response = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
          messages: [{ role: "user", content: `${SEARCH_PROMPT_PREFIX}${query}` }]
        }),
        signal: withDeadline(signal, SEARCH_TIMEOUT_MS)
      });
      if (!response.ok) throw searchError("anthropic", response.status, await response.text());
      return decodeAnthropicWebSearchResult(await response.json());
    }
  };
}

// ---- selection ----

/**
 * The executor for a dialect: the matching provider when its key is present,
 * the other provider as fallback (working search beats provider purity), or
 * `undefined` when the feature is off (`ROUTEKIT_WEB_SEARCH=0` or no keys),
 * in which case the adapters keep dropping the tool with a warning.
 */
export function resolveWebSearchExecutor(
  dialect: WebSearchDialect,
  env: Record<string, string | undefined> = process.env
): WebSearchExecutor | undefined {
  if (env.ROUTEKIT_WEB_SEARCH === "0") return undefined;
  const openAiKey = env.OPENAI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;
  const openAi =
    openAiKey !== undefined && openAiKey.length > 0 ? openAiExecutor(openAiKey, env) : undefined;
  const anthropic =
    anthropicKey !== undefined && anthropicKey.length > 0
      ? anthropicExecutor(anthropicKey, env)
      : undefined;
  switch (dialect) {
    case "responses":
      return openAi ?? anthropic;
    case "anthropic":
      return anthropic ?? openAi;
    default: {
      const exhaustive: never = dialect;
      throw new Error(`unknown web search dialect: ${String(exhaustive)}`);
    }
  }
}
