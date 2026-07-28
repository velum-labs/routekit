/**
 * Provider-neutral reasoning controls discovered for one opaque model id.
 *
 * Effort ids deliberately remain strings: providers can add values without a
 * RouteKit release. Ordering is provider-authored and therefore suitable for
 * selector presentation and deterministic cross-wire aliases.
 */
export type ReasoningEffortOption = {
  id: string;
  label?: string;
  description?: string;
  aliases?: readonly string[];
};

export type ReasoningCapabilityProvenance =
  | "provider"
  | "config"
  | "builtin"
  | "unknown";
export type ReasoningCapabilityStatus = "supported" | "unsupported" | "unknown";

export type ModelReasoningCapabilities = {
  status: ReasoningCapabilityStatus;
  efforts?: readonly ReasoningEffortOption[];
  defaultEffort?: string;
  budget?: {
    minTokens?: number;
    maxTokens?: number;
    defaultTokens?: number;
  };
  adaptive?: boolean;
  /**
   * Opaque provider-adapter discriminator. Model routing never interprets it;
   * only the provider source that authored the capability may consume it.
   */
  wireShape?: string;
  provenance: ReasoningCapabilityProvenance;
  refreshedAt?: string;
};

export type ReasoningSelection =
  | { mode: "auto" }
  | { mode: "disabled" }
  | { mode: "adaptive" }
  | { mode: "effort"; effort: string }
  | { mode: "budget"; budgetTokens: number };

export function resolveReasoningEffort(
  capabilities: ModelReasoningCapabilities,
  requested: string
): string | undefined {
  for (const option of capabilities.efforts ?? []) {
    if (option.id === requested || option.aliases?.includes(requested) === true) {
      return option.id;
    }
  }
  return undefined;
}

/**
 * Conservative Codex picker heuristic for a model's discovered provenance.
 *
 * Codex uses the Responses API, so OpenRouter models are listed only when
 * their existing reasoning metadata says `supported`. Other providers remain
 * eligible when capability discovery is absent or inconclusive. This is only
 * a picker heuristic; it does not guarantee compatibility with encrypted
 * Responses reasoning state or continuation across models.
 */
export function isCodexPickerEligibleModel(input: {
  provider?: string;
  reasoning?: Pick<ModelReasoningCapabilities, "status">;
}): boolean {
  return input.provider !== "openrouter" || input.reasoning?.status === "supported";
}
