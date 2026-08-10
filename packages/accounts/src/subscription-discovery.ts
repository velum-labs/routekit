import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ReasoningEffortOption
} from "@velum-labs/routekit-contracts";
import type {
  ProviderDiscoveryResponseShape,
  SubscriptionMode
} from "@velum-labs/routekit-registry";
import type { SubscriptionDiscoveredModel } from "./provider-port.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
}

function capabilitySupported(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return isRecord(value) && typeof value.supported === "boolean" ? value.supported : undefined;
}

function effortOptions(value: unknown): ReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate): ReasoningEffortOption[] => {
    const record = isRecord(candidate) ? candidate : undefined;
    const id =
      typeof candidate === "string"
        ? candidate
        : typeof record?.effort === "string"
          ? record.effort
          : typeof record?.id === "string"
            ? record.id
            : undefined;
    if (id === undefined || id.length === 0 || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        ...(typeof record?.label === "string" ? { label: record.label } : {}),
        ...(typeof record?.description === "string" ? { description: record.description } : {}),
        ...(Array.isArray(record?.aliases)
          ? {
              aliases: record.aliases.filter(
                (alias): alias is string => typeof alias === "string" && alias.length > 0
              )
            }
          : {})
      }
    ];
  });
}

function reasoningCapabilities(
  entry: unknown,
  mode: SubscriptionMode,
  refreshedAt = new Date().toISOString()
): ModelReasoningCapabilities | undefined {
  if (!isRecord(entry)) return undefined;
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
  const nested =
    (isRecord(entry.reasoning) ? entry.reasoning : undefined) ??
    (isRecord(capabilities?.reasoning) ? capabilities.reasoning : undefined);
  const discoveredEfforts = effortOptions(
    entry.supported_reasoning_levels ??
      entry.supported_reasoning_efforts ??
      nested?.efforts ??
      nested?.supported_efforts
  );
  const providerEffort =
    mode === "claude-code" && isRecord(capabilities?.effort) ? capabilities.effort : undefined;
  const thinking =
    mode === "claude-code" && isRecord(capabilities?.thinking) ? capabilities.thinking : undefined;
  const thinkingTypes = isRecord(thinking?.types) ? thinking.types : undefined;
  const effortSupported = capabilitySupported(providerEffort?.supported);
  const thinkingSupported = capabilitySupported(thinking?.supported);
  const adaptiveSupported = capabilitySupported(thinkingTypes?.adaptive);
  const enabledSupported = capabilitySupported(thinkingTypes?.enabled);
  const anthropicEfforts =
    effortSupported === true
      ? (["low", "medium", "high", "xhigh", "max"] as const).flatMap((id) =>
          capabilitySupported(providerEffort?.[id]) === true ? [{ id }] : []
        )
      : [];
  const efforts = discoveredEfforts.length > 0 ? discoveredEfforts : anthropicEfforts;
  const supportedParameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter(
        (parameter): parameter is string => typeof parameter === "string"
      )
    : [];
  const explicitStatus =
    nested?.status ?? capabilities?.reasoning_controls ?? entry.reasoning_controls;
  const supported =
    efforts.length > 0 ||
    effortSupported === true ||
    thinkingSupported === true ||
    adaptiveSupported === true ||
    enabledSupported === true ||
    supportedParameters.includes("reasoning") ||
    supportedParameters.includes("reasoning_effort") ||
    explicitStatus === "supported";
  const unsupported =
    explicitStatus === "unsupported" ||
    nested?.supported === false ||
    (effortSupported === false && thinkingSupported === false);
  if (
    !supported &&
    !unsupported &&
    nested === undefined &&
    providerEffort === undefined &&
    thinking === undefined
  ) {
    return undefined;
  }
  const defaultEffort =
    typeof entry.default_reasoning_level === "string"
      ? entry.default_reasoning_level
      : typeof nested?.default_effort === "string"
        ? nested.default_effort
        : typeof nested?.defaultEffort === "string"
          ? nested.defaultEffort
          : undefined;
  const budgetSource = isRecord(nested?.budget) ? nested.budget : undefined;
  const budget =
    budgetSource === undefined
      ? enabledSupported === true
        ? { minTokens: 1_024 }
        : undefined
      : {
          ...(typeof budgetSource.min_tokens === "number"
            ? { minTokens: budgetSource.min_tokens }
            : typeof budgetSource.minTokens === "number"
              ? { minTokens: budgetSource.minTokens }
              : {}),
          ...(typeof budgetSource.max_tokens === "number"
            ? { maxTokens: budgetSource.max_tokens }
            : typeof budgetSource.maxTokens === "number"
              ? { maxTokens: budgetSource.maxTokens }
              : {}),
          ...(typeof budgetSource.default_tokens === "number"
            ? { defaultTokens: budgetSource.default_tokens }
            : typeof budgetSource.defaultTokens === "number"
              ? { defaultTokens: budgetSource.defaultTokens }
              : {})
        };
  const adaptive = typeof nested?.adaptive === "boolean" ? nested.adaptive : adaptiveSupported;
  return {
    status: unsupported ? "unsupported" : supported ? "supported" : "unknown",
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(adaptive !== undefined ? { adaptive } : {}),
    wireShape: mode === "codex" ? "openai-responses" : "anthropic",
    provenance: "provider",
    refreshedAt
  };
}

function modelMetadata(
  mode: SubscriptionMode,
  entry: Record<string, unknown>
): ModelCapabilityMetadata {
  const inputModalities = stringList(entry.input_modalities);
  const input =
    mode === "claude-code" ? ["text"] : inputModalities.length > 0 ? inputModalities : ["text"];
  return {
    architecture: {
      modality: `${input.join("+")}->text`,
      inputModalities: input,
      outputModalities: ["text"]
    },
    supportedParameters: ["tools", "tool_choice"],
    provenance: "route"
  };
}

function modelId(value: unknown, key: "id" | "slug"): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") return undefined;
  const id = value[key].trim();
  return id.length > 0 ? id : undefined;
}

export function parseSubscriptionModels(
  shape: ProviderDiscoveryResponseShape,
  payload: unknown,
  mode: SubscriptionMode
): SubscriptionDiscoveredModel[] {
  if (!isRecord(payload)) throw new Error("model discovery returned a non-object payload");
  const entries =
    shape === "anthropic"
      ? Array.isArray(payload.data)
        ? payload.data
        : []
      : Array.isArray(payload.models)
        ? payload.models
        : [];
  const key = shape === "codex" ? "slug" : "id";
  const seen = new Set<string>();
  const models: SubscriptionDiscoveredModel[] = [];
  for (const entry of entries) {
    const id = modelId(entry, key);
    const record = isRecord(entry) ? entry : undefined;
    if (
      id === undefined ||
      record === undefined ||
      seen.has(id) ||
      (mode === "codex" && record.supported_in_api === false)
    )
      continue;
    seen.add(id);
    const capabilities = isRecord(record.capabilities)
      ? Object.fromEntries(
          Object.entries(record.capabilities).flatMap(([name, value]) =>
            typeof value === "string" ? [[name, value]] : []
          )
        )
      : undefined;
    const reasoning = reasoningCapabilities(record, mode);
    models.push({
      id,
      ...(capabilities !== undefined && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      metadata: modelMetadata(mode, record),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(mode === "codex" &&
      typeof record.priority === "number" &&
      Number.isInteger(record.priority) &&
      record.priority >= 0
        ? { providerPriority: record.priority }
        : {})
    });
  }
  if (models.length === 0) throw new Error(`model discovery returned no usable ${shape} models`);
  return models;
}
