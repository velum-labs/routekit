import type {
  ModelArchitecture,
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ReasoningEffortOption
} from "@velum-labs/routekit-contracts";
import type { ProviderDiscoveryResponseShape } from "@velum-labs/routekit-registry";

import type { DiscoveredModel, ProviderId } from "./provider-types.js";
import {
  decodeModelDiscoveryPayload,
  ProviderProtocolError
} from "./provider-protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function reasoningWireShape(provider: ProviderId | undefined): string | undefined {
  switch (provider) {
    case "codex":
      return "openai-responses";
    case "anthropic":
    case "claude-code":
      return "anthropic";
    case "bedrock":
      return "bedrock-converse";
    case "google":
      return "google";
    case "openrouter":
      return "openrouter";
    case "openai":
    case "cliproxy":
      return "openai-chat";
    case undefined:
      return undefined;
  }
}

const ANTHROPIC_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

function capabilitySupported(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    return undefined;
  }
  return value.supported;
}

export function parseReasoningCapabilities(
  entry: unknown,
  provider?: ProviderId,
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
  const anthropicEffort =
    provider === "anthropic" || provider === "claude-code"
      ? isRecord(capabilities?.effort)
        ? capabilities.effort
        : undefined
      : undefined;
  const anthropicThinking =
    provider === "anthropic" || provider === "claude-code"
      ? isRecord(capabilities?.thinking)
        ? capabilities.thinking
        : undefined
      : undefined;
  const thinkingTypes = isRecord(anthropicThinking?.types) ? anthropicThinking.types : undefined;
  const effortSupported = capabilitySupported(anthropicEffort?.supported);
  const thinkingSupported = capabilitySupported(anthropicThinking?.supported);
  const adaptiveSupported = capabilitySupported(thinkingTypes?.adaptive);
  const enabledSupported = capabilitySupported(thinkingTypes?.enabled);
  const anthropicEfforts =
    effortSupported === true
      ? ANTHROPIC_EFFORT_ORDER.flatMap((id): ReasoningEffortOption[] =>
          capabilitySupported(anthropicEffort?.[id]) === true ? [{ id }] : []
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
  const hasAnthropicMetadata = anthropicEffort !== undefined || anthropicThinking !== undefined;
  if (!supported && !unsupported && nested === undefined && !hasAnthropicMetadata) {
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
  const nestedBudget =
    budgetSource === undefined
      ? undefined
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
  const budget = nestedBudget ?? (enabledSupported === true ? { minTokens: 1_024 } : undefined);
  const adaptive = typeof nested?.adaptive === "boolean" ? nested.adaptive : adaptiveSupported;
  return {
    status: unsupported ? "unsupported" : supported ? "supported" : "unknown",
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(adaptive !== undefined ? { adaptive } : {}),
    ...(reasoningWireShape(provider) !== undefined
      ? { wireShape: reasoningWireShape(provider) }
      : {}),
    provenance: "provider",
    refreshedAt
  };
}

function modelId(value: unknown, key: "id" | "name" | "slug"): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") return undefined;
  const id = value[key].trim();
  if (id.length === 0) return undefined;
  return key === "name" && id.startsWith("models/") ? id.slice("models/".length) : id;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
}

function createdAtSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed / 1_000) : undefined;
}

function providerPriority(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function architectureFromOpenRouter(entry: Record<string, unknown>): ModelArchitecture | undefined {
  const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
  if (architecture === undefined) return undefined;
  const inputModalities = stringList(architecture.input_modalities);
  const outputModalities = stringList(architecture.output_modalities);
  const modality =
    typeof architecture.modality === "string" || architecture.modality === null
      ? architecture.modality
      : undefined;
  if (inputModalities.length === 0 && outputModalities.length === 0 && modality === undefined) {
    return undefined;
  }
  return {
    ...(modality !== undefined ? { modality } : {}),
    inputModalities,
    outputModalities
  };
}

function discoveredMetadata(
  entry: Record<string, unknown>,
  provider: ProviderId | undefined
): ModelCapabilityMetadata | undefined {
  if (provider === "openrouter") {
    const architecture = architectureFromOpenRouter(entry);
    const supportedParameters = stringList(entry.supported_parameters);
    const hasSupportedParameters = Array.isArray(entry.supported_parameters);
    if (architecture === undefined && !hasSupportedParameters) return undefined;
    return {
      ...(architecture !== undefined ? { architecture } : {}),
      ...(hasSupportedParameters ? { supportedParameters } : {}),
      provenance: "provider"
    };
  }
  if (provider === "codex") {
    const inputModalities = stringList(entry.input_modalities);
    return {
      architecture: {
        modality: `${(inputModalities.length > 0 ? inputModalities : ["text"]).join("+")}->text`,
        inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
        outputModalities: ["text"]
      },
      supportedParameters: ["tools", "tool_choice"],
      provenance: "route"
    };
  }
  if (provider === "anthropic" || provider === "claude-code") {
    const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
    const imageInput = capabilitySupported(
      isRecord(capabilities?.image_input) ? capabilities.image_input.supported : undefined
    );
    const inputModalities = imageInput === true ? ["text", "image"] : ["text"];
    return {
      architecture: {
        modality: `${inputModalities.join("+")}->text`,
        inputModalities,
        outputModalities: ["text"]
      },
      supportedParameters: ["tools", "tool_choice"],
      provenance: "route"
    };
  }
  return undefined;
}

export function parseDiscoveredModels(
  shape: ProviderDiscoveryResponseShape,
  payload: unknown,
  provider?: ProviderId
): DiscoveredModel[] {
  const entries = decodeModelDiscoveryPayload(shape, payload, provider);
  const key = shape === "google" ? "name" : shape === "codex" ? "slug" : "id";
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    const id = modelId(entry, key);
    const record = isRecord(entry) ? entry : undefined;
    if (
      id === undefined ||
      seen.has(id) ||
      (provider === "codex" && record?.supported_in_api === false)
    ) {
      continue;
    }
    seen.add(id);
    const capabilities =
      record !== undefined && isRecord(record.capabilities)
        ? Object.fromEntries(
            Object.entries(record.capabilities).flatMap(([name, value]) =>
              typeof value === "string" ? [[name, value]] : []
            )
          )
        : undefined;
    const reasoning = parseReasoningCapabilities(entry, provider);
    const metadata = record === undefined ? undefined : discoveredMetadata(record, provider);
    const createdAt =
      record === undefined ? undefined : createdAtSeconds(record.created ?? record.created_at);
    const preference =
      provider === "codex" && record !== undefined ? providerPriority(record.priority) : undefined;
    models.push({
      id,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(preference !== undefined ? { providerPriority: preference } : {}),
      ...(capabilities !== undefined && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(reasoning !== undefined ? { reasoning } : {})
    });
  }
  if (models.length === 0) {
    throw new ProviderProtocolError(
      provider ?? shape,
      "model discovery",
      `returned no usable ${shape} models`,
      payload
    );
  }
  return models;
}
