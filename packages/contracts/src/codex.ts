import type {
  CapabilityStatus,
  ModelArchitecture,
  ModelCapabilityMetadata,
  ModelSelectionSignals
} from "./model.js";
import {
  isCodexPickerEligibleModel,
  type ModelReasoningCapabilities
} from "./reasoning.js";

export type CodexCompatibilityStatus = "compatible" | "incompatible" | "unknown";

export type CodexCompatibility = {
  status: CodexCompatibilityStatus;
  reason?: string;
};

export type CodexBillingScope = "metered-api" | "subscription" | "upstream-managed";

export type CodexModelCandidate = ModelSelectionSignals & {
  id: string;
  nativeId?: string;
  provider?: string;
  billingScope?: CodexBillingScope;
  architecture?: ModelArchitecture;
  supportedParameters?: readonly string[];
  capabilities?: Readonly<Record<string, CapabilityStatus>>;
  reasoning?: Pick<ModelReasoningCapabilities, "status">;
};

export type CodexStartupSelection = {
  model: string;
  compatibleModelIds: readonly string[];
};

const CODEX_ROUTE_PROVIDERS = new Set([
  "codex",
  "claude-code",
  "openrouter",
  "openai",
  "bedrock"
]);

export function codexCompatibility(model: CodexModelCandidate): CodexCompatibility {
  if (model.provider === undefined || !CODEX_ROUTE_PROVIDERS.has(model.provider)) {
    return { status: "unknown", reason: "the provider has no Codex compatibility projection" };
  }
  if (!isCodexPickerEligibleModel(model)) {
    return {
      status: "incompatible",
      reason: "the model cannot safely preserve Responses reasoning state"
    };
  }
  const output = model.architecture?.outputModalities;
  if (output === undefined) {
    return { status: "unknown", reason: "output modalities were not advertised" };
  }
  if (!output.includes("text")) {
    return {
      status: "incompatible",
      reason: `the model outputs ${output.length === 0 ? "no advertised modality" : output.join(", ")}`
    };
  }
  const tools =
    model.supportedParameters?.includes("tools") === true ||
    model.capabilities?.tools === "supported";
  if (!tools) {
    if (
      model.supportedParameters === undefined &&
      (model.capabilities?.tools === undefined || model.capabilities.tools === "unknown")
    ) {
      return { status: "unknown", reason: "tool support was not advertised" };
    }
    return { status: "incompatible", reason: "tool calling is not supported" };
  }
  return { status: "compatible" };
}

function compareModelIds(left: CodexModelCandidate, right: CodexModelCandidate): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareCreatedAt(
  left: CodexModelCandidate,
  right: CodexModelCandidate
): number {
  if (left.createdAt !== undefined && right.createdAt === undefined) return -1;
  if (left.createdAt === undefined && right.createdAt !== undefined) return 1;
  if (
    left.createdAt !== undefined &&
    right.createdAt !== undefined &&
    left.createdAt !== right.createdAt
  ) {
    return right.createdAt - left.createdAt;
  }
  return compareModelIds(left, right);
}

/**
 * Provider-authored priority is meaningful only inside that provider. A
 * timestamp breaks equal-priority ties and ranks providers without priority.
 */
function compareWithinProvider(
  left: CodexModelCandidate,
  right: CodexModelCandidate
): number {
  if (left.providerPriority !== undefined && right.providerPriority === undefined) {
    return -1;
  }
  if (left.providerPriority === undefined && right.providerPriority !== undefined) {
    return 1;
  }
  if (
    left.providerPriority !== undefined &&
    right.providerPriority !== undefined &&
    left.providerPriority !== right.providerPriority
  ) {
    return left.providerPriority - right.providerPriority;
  }
  return compareCreatedAt(left, right);
}

function selectAcrossProviders(
  candidates: readonly CodexModelCandidate[]
): CodexModelCandidate | undefined {
  const byProvider = new Map<string, CodexModelCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.provider ?? "";
    const group = byProvider.get(key);
    if (group === undefined) {
      byProvider.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  const winners = [...byProvider.values()].map(
    (group) => group.sort(compareWithinProvider)[0]!
  );
  return winners.sort(compareCreatedAt)[0];
}

/**
 * Select an already-enriched Codex startup model.
 *
 * Explicit selection remains exact and validates only catalog membership, as
 * before. Implicit selection is fail-closed and billing-scope preserving.
 */
export function selectCodexStartupModel(input: {
  models: readonly CodexModelCandidate[];
  preferredModel?: string;
  requestedModel?: string;
}): CodexStartupSelection {
  const byId = new Map(input.models.map((model) => [model.id, model]));
  if (input.requestedModel !== undefined) {
    if (!byId.has(input.requestedModel)) {
      throw new Error(`unknown model "${input.requestedModel}"`);
    }
    return {
      model: input.requestedModel,
      compatibleModelIds: input.models
        .filter((model) => codexCompatibility(model).status === "compatible")
        .sort(compareModelIds)
        .map((model) => model.id)
    };
  }

  const preferred =
    input.preferredModel === undefined ? undefined : byId.get(input.preferredModel);
  const compatible = input.models
    .filter((model) => codexCompatibility(model).status === "compatible")
    .sort(compareModelIds);
  const billingScoped =
    preferred?.billingScope === undefined
      ? compatible
      : compatible.filter((model) => model.billingScope === preferred.billingScope);
  const providerScoped =
    preferred?.provider === undefined
      ? []
      : billingScoped.filter((model) => model.provider === preferred.provider);
  const selected =
    preferred !== undefined && codexCompatibility(preferred).status === "compatible"
      ? preferred
      : providerScoped.length > 0
        ? [...providerScoped].sort(compareWithinProvider)[0]
        : selectAcrossProviders(billingScoped);
  if (selected === undefined) {
    throw new Error(
      "routekit codex found no advertised model with text output and tool support " +
        "that is compatible with the Responses path. Configure a compatible default " +
        "or run `routekit codex <provider/model>`."
    );
  }
  return {
    model: selected.id,
    compatibleModelIds: compatible.map((model) => model.id)
  };
}

export function withCodexCapabilityMetadata(
  model: CodexModelCandidate,
  metadata: ModelCapabilityMetadata
): CodexModelCandidate {
  return {
    ...model,
    ...(metadata.architecture !== undefined ? { architecture: metadata.architecture } : {}),
    ...(metadata.supportedParameters !== undefined
      ? { supportedParameters: metadata.supportedParameters }
      : {})
  };
}
