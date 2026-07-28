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

/**
 * Canonical effort descriptor for picker and catalog projection.
 *
 * `label` is always populated (`description ?? label ?? id`) so surfaces do
 * not reimplement presentation fallbacks.
 */
export type ReasoningEffortDescriptor = {
  id: string;
  label: string;
  aliases: readonly string[];
};

/**
 * One served model as seen by a client surface.
 *
 * `clientModel` is the surface-specific spelling used for discovery and
 * launch (for example Claude's `claude-` alias or Cursor's `routekit/`
 * namespace). Qualification happens against that spelling plus the served
 * `model` id so both advertised and unsuffixed requests resolve.
 */
export type ModelEffortVariantEntry = {
  model: string;
  clientModel: string;
  reasoning?: ModelReasoningCapabilities;
};

export type ModelEffortVariant = {
  /** Client-facing model id, including any effort qualification. */
  id: string;
  /** Canonical served model id. */
  model: string;
  selection: ReasoningSelection;
  effort?: ReasoningEffortDescriptor;
};

/**
 * Surface-specific spelling of effort-qualified model ids.
 *
 * A new surface supplies only these callbacks. Filtering, alias normalization,
 * exact-base precedence, and structured errors stay in contracts.
 */
export type ModelEffortVariantCodec = {
  qualify(baseClientModel: string, effort: string): string;
  /**
   * When `candidate` is a qualification of `baseClientModel`, return the
   * opaque effort token. Must not invent tokens for unrelated models.
   */
  effortToken(candidate: string, baseClientModel: string): string | undefined;
};

export type ReasoningSelectionErrorCode =
  | "unknown_capability"
  | "unsupported"
  | "unsupported_effort"
  | "unsupported_adaptive"
  | "unsupported_budget"
  | "budget_out_of_range"
  | "invalid_selection";

export type ReasoningSelectionResolution =
  | { ok: true; selection: ReasoningSelection }
  | { ok: false; code: ReasoningSelectionErrorCode; message: string };

export type ModelEffortVariantErrorCode =
  | "unknown_model"
  | "unsupported_effort"
  | "collision";

export type ModelEffortVariantResolution =
  | {
      ok: true;
      model: string;
      clientModel: string;
      selection: ReasoningSelection;
    }
  | { ok: false; code: ModelEffortVariantErrorCode; message: string };

/** Default `<base>:<effort>` qualification used by Claude and Cursor pickers. */
export const EFFORT_QUALIFIED_MODEL_CODEC: ModelEffortVariantCodec = {
  qualify(baseClientModel, effort) {
    return `${baseClientModel}:${effort}`;
  },
  effortToken(candidate, baseClientModel) {
    const prefix = `${baseClientModel}:`;
    if (!candidate.startsWith(prefix)) return undefined;
    const token = candidate.slice(prefix.length);
    return token.length > 0 ? token : undefined;
  }
};

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
 * Ordered unique effort descriptors advertised for one model.
 *
 * Only `status: "supported"` capabilities contribute. Aliases are retained on
 * the descriptor for resolution but are never separate picker entries.
 */
export function reasoningEffortDescriptors(
  capabilities: ModelReasoningCapabilities | undefined
): ReasoningEffortDescriptor[] {
  if (capabilities?.status !== "supported") return [];
  const descriptors: ReasoningEffortDescriptor[] = [];
  const seen = new Set<string>();
  for (const option of capabilities.efforts ?? []) {
    if (typeof option.id !== "string" || option.id.length === 0) continue;
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    const aliases = [
      ...new Set(
        (option.aliases ?? []).filter(
          (alias): alias is string => typeof alias === "string" && alias.length > 0
        )
      )
    ];
    descriptors.push({
      id: option.id,
      label: option.description ?? option.label ?? option.id,
      aliases
    });
  }
  return descriptors;
}

export function parseReasoningSelection(
  value: unknown
): ReasoningSelectionResolution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      code: "invalid_selection",
      message: "reasoning selection must be an object"
    };
  }
  const selection = value as Record<string, unknown>;
  const mode = selection.mode;
  if (typeof mode !== "string") {
    return {
      ok: false,
      code: "invalid_selection",
      message: "reasoning selection mode must be a string"
    };
  }
  if (mode === "auto" || mode === "disabled" || mode === "adaptive") {
    if ("effort" in selection || "budgetTokens" in selection) {
      return {
        ok: false,
        code: "invalid_selection",
        message: `reasoning selection mode "${mode}" does not accept effort or budgetTokens`
      };
    }
    return { ok: true, selection: { mode } };
  }
  if (mode === "effort") {
    if (typeof selection.effort !== "string" || selection.effort.length === 0) {
      return {
        ok: false,
        code: "invalid_selection",
        message: "reasoning selection effort must be a non-empty string"
      };
    }
    if ("budgetTokens" in selection) {
      return {
        ok: false,
        code: "invalid_selection",
        message: 'reasoning selection mode "effort" does not accept budgetTokens'
      };
    }
    return { ok: true, selection: { mode, effort: selection.effort } };
  }
  if (mode === "budget") {
    if (!Number.isInteger(selection.budgetTokens) || (selection.budgetTokens as number) <= 0) {
      return {
        ok: false,
        code: "invalid_selection",
        message: "reasoning selection budgetTokens must be a positive integer"
      };
    }
    if ("effort" in selection) {
      return {
        ok: false,
        code: "invalid_selection",
        message: 'reasoning selection mode "budget" does not accept effort'
      };
    }
    return {
      ok: true,
      selection: { mode, budgetTokens: selection.budgetTokens as number }
    };
  }
  return {
    ok: false,
    code: "invalid_selection",
    message: `reasoning selection mode is unsupported: ${JSON.stringify(mode)}`
  };
}

export function reasoningSelectionEquals(
  left: ReasoningSelection,
  right: ReasoningSelection
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "effort" && right.mode === "effort") {
    return left.effort === right.effort;
  }
  if (left.mode === "budget" && right.mode === "budget") {
    return left.budgetTokens === right.budgetTokens;
  }
  return true;
}

/**
 * Validate and canonicalize a selection against discovered capabilities.
 *
 * Codex's historical `"none"` → disabled mapping stays at the gateway boundary;
 * this helper treats `"none"` like any other opaque effort id.
 */
export function resolveReasoningSelection(
  capabilities: ModelReasoningCapabilities | undefined,
  selection: ReasoningSelection
): ReasoningSelectionResolution {
  if (selection.mode === "auto" || selection.mode === "disabled") {
    return { ok: true, selection };
  }
  if (capabilities === undefined || capabilities.status === "unknown") {
    return {
      ok: false,
      code: "unknown_capability",
      message: "model has no discovered reasoning controls"
    };
  }
  if (capabilities.status === "unsupported") {
    return {
      ok: false,
      code: "unsupported",
      message: "model does not support reasoning controls"
    };
  }
  if (selection.mode === "effort") {
    const effort = resolveReasoningEffort(capabilities, selection.effort);
    if (effort === undefined) {
      return {
        ok: false,
        code: "unsupported_effort",
        message: `reasoning effort "${selection.effort}" is not supported`
      };
    }
    return { ok: true, selection: { mode: "effort", effort } };
  }
  if (selection.mode === "adaptive") {
    return capabilities.adaptive === true
      ? { ok: true, selection }
      : {
          ok: false,
          code: "unsupported_adaptive",
          message: "adaptive reasoning is not supported"
        };
  }
  const budget = capabilities.budget;
  if (budget === undefined) {
    return {
      ok: false,
      code: "unsupported_budget",
      message: "reasoning token budgets are not supported"
    };
  }
  if (budget.minTokens !== undefined && selection.budgetTokens < budget.minTokens) {
    return {
      ok: false,
      code: "budget_out_of_range",
      message: `reasoning budget must be at least ${budget.minTokens} tokens`
    };
  }
  if (budget.maxTokens !== undefined && selection.budgetTokens > budget.maxTokens) {
    return {
      ok: false,
      code: "budget_out_of_range",
      message: `reasoning budget must be at most ${budget.maxTokens} tokens`
    };
  }
  return { ok: true, selection };
}

export function reasoningSelectionFromEffort(
  capabilities: ModelReasoningCapabilities | undefined,
  requested: string
): ReasoningSelectionResolution {
  return resolveReasoningSelection(capabilities, {
    mode: "effort",
    effort: requested
  });
}

/**
 * Expand one served model into the base client id plus one variant per
 * discovered effort. Aliases are not advertised as separate entries.
 */
export function enumerateModelEffortVariants(
  entry: ModelEffortVariantEntry,
  codec: ModelEffortVariantCodec = EFFORT_QUALIFIED_MODEL_CODEC
): ModelEffortVariant[] {
  const variants: ModelEffortVariant[] = [
    {
      id: entry.clientModel,
      model: entry.model,
      selection: { mode: "auto" }
    }
  ];
  for (const effort of reasoningEffortDescriptors(entry.reasoning)) {
    variants.push({
      id: codec.qualify(entry.clientModel, effort.id),
      model: entry.model,
      selection: { mode: "effort", effort: effort.id },
      effort
    });
  }
  return variants;
}

/**
 * Detect generated client ids that collide across distinct served models or
 * effort selections. Exact base ids always win at resolve time; collisions are
 * reported so surfaces can refuse to advertise ambiguous catalogs.
 */
export function modelEffortVariantCollisions(
  entries: readonly ModelEffortVariantEntry[],
  codec: ModelEffortVariantCodec = EFFORT_QUALIFIED_MODEL_CODEC
): string[] {
  const owners = new Map<string, string>();
  const collisions = new Set<string>();
  for (const entry of entries) {
    for (const variant of enumerateModelEffortVariants(entry, codec)) {
      const owner = `${variant.model}\0${JSON.stringify(variant.selection)}`;
      const previous = owners.get(variant.id);
      if (previous === undefined) {
        owners.set(variant.id, owner);
        continue;
      }
      if (previous !== owner) collisions.add(variant.id);
    }
  }
  return [...collisions].sort();
}

/**
 * Resolve a client-facing model id back to its served model and selection.
 *
 * Exact served/`clientModel` ids win before qualification. Qualification is
 * codec-defined against known bases (longest first), never a global delimiter
 * split, so opaque model ids that themselves contain `:` remain addressable.
 */
export function resolveModelEffortVariant(
  requested: string,
  entries: readonly ModelEffortVariantEntry[],
  codec: ModelEffortVariantCodec = EFFORT_QUALIFIED_MODEL_CODEC
): ModelEffortVariantResolution {
  if (requested.length === 0) {
    return {
      ok: false,
      code: "unknown_model",
      message: "model id is empty"
    };
  }

  for (const entry of entries) {
    if (entry.model === requested || entry.clientModel === requested) {
      return {
        ok: true,
        model: entry.model,
        clientModel: entry.clientModel,
        selection: { mode: "auto" }
      };
    }
  }

  const ordered = [...entries].sort(
    (left, right) =>
      Math.max(right.clientModel.length, right.model.length) -
      Math.max(left.clientModel.length, left.model.length)
  );
  for (const entry of ordered) {
    const bases = entry.clientModel === entry.model
      ? [entry.clientModel]
      : [entry.clientModel, entry.model];
    for (const base of bases) {
      const token = codec.effortToken(requested, base);
      if (token === undefined) continue;
      const resolved = reasoningSelectionFromEffort(entry.reasoning, token);
      if (resolved.ok) {
        return {
          ok: true,
          model: entry.model,
          clientModel: entry.clientModel,
          selection: resolved.selection
        };
      }
      return {
        ok: false,
        code: "unsupported_effort",
        message:
          resolved.code === "unsupported_effort"
            ? `reasoning effort "${token}" is not supported by model "${entry.model}"`
            : `model "${entry.model}" has no discovered reasoning effort controls`
      };
    }
  }

  return {
    ok: false,
    code: "unknown_model",
    message: `unknown model: ${requested}`
  };
}

/**
 * Project a launch/session effort selection onto a client model id.
 *
 * Surfaces that encode effort in the model name use this helper so launchers,
 * pickers, and gateway discovery stay aligned. Non-effort selections leave the
 * base id unchanged.
 */
export function effortQualifiedClientModel(
  baseClientModel: string,
  selection: ReasoningSelection | undefined,
  codec: ModelEffortVariantCodec = EFFORT_QUALIFIED_MODEL_CODEC
): string {
  if (selection?.mode !== "effort") return baseClientModel;
  return codec.qualify(baseClientModel, selection.effort);
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
