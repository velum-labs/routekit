/**
 * OpenAI builtin reasoning catalog. Discovery often omits effort metadata for
 * GPT-5.5 / GPT-5.6, so the OpenAI provider source authors the verified
 * controls. Config overrides and provider-authored discovery still win.
 */

import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";

export function openaiReasoningCapabilities(
  modelId: string
): ModelReasoningCapabilities | undefined {
  if (/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
    return {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultEffort: "medium",
      wireShape: "openai-responses",
      provenance: "builtin"
    };
  }
  if (/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
    return {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
      wireShape: "openai-chat",
      provenance: "builtin"
    };
  }
  return undefined;
}

/** GPT-5.x Chat Completions reject legacy `max_tokens`; use `max_completion_tokens`. */
export function openaiChatUsesMaxCompletionTokens(modelId: string): boolean {
  return /(?:^|[./])gpt-5(?:[.:-]|$)/.test(modelId);
}
