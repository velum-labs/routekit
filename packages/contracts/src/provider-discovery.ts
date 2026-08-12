import type {
  ModelArchitecture,
  ModelCapabilityMetadata,
  ModelSelectionSignals
} from "./model.js";
import type {
  ModelReasoningCapabilities,
  ReasoningEffortOption
} from "./reasoning.js";

export type ProviderDiscoveryResponseShape =
  | "openai"
  | "anthropic"
  | "google"
  | "codex"
  | "bedrock";

export type DiscoveredProviderModel = ModelSelectionSignals & {
  id: string;
  capabilities?: Readonly<Record<string, string>>;
  metadata?: ModelCapabilityMetadata;
  reasoning?: ModelReasoningCapabilities;
};

export type ModelDiscoveryDiagnosticCode =
  | "invalid_model"
  | "duplicate_model"
  | "provider_hidden_model";

export type ModelDiscoveryDiagnostic = Readonly<{
  code: ModelDiscoveryDiagnosticCode;
  provider: string;
  index: number;
  message: string;
}>;

export type ModelDiscoveryProtocolErrorCode =
  | "invalid_payload"
  | "missing_model_array"
  | "no_usable_models";

export class ModelDiscoveryProtocolError extends Error {
  readonly code: ModelDiscoveryProtocolErrorCode;
  readonly provider: string;
  readonly payloadSnippet?: string;

  constructor(
    code: ModelDiscoveryProtocolErrorCode,
    provider: string,
    message: string,
    payload?: unknown,
    options?: ErrorOptions
  ) {
    super(`${provider} model discovery: ${message}`, options);
    this.name = "ModelDiscoveryProtocolError";
    this.code = code;
    this.provider = provider;
    const snippet = payloadSnippet(payload);
    if (snippet !== undefined) this.payloadSnippet = snippet;
  }
}

export type DecodeModelDiscoveryOptions = Readonly<{
  provider?: string;
  refreshedAt?: string;
  onDiagnostic?: (diagnostic: ModelDiscoveryDiagnostic) => void;
}>;

export type DecodeReasoningCapabilitiesOptions = Readonly<{
  provider?: string;
  refreshedAt?: string;
}>;

type ProviderRecord = Readonly<Record<string, unknown>>;

function payloadSnippet(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

function isRecord(value: unknown): value is ProviderRecord {
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

function reasoningWireShape(provider: string | undefined): string | undefined {
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
    default:
      return undefined;
  }
}

const ANTHROPIC_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

export function decodeReasoningCapabilities(
  entry: unknown,
  options: DecodeReasoningCapabilitiesOptions = {}
): ModelReasoningCapabilities | undefined {
  if (!isRecord(entry)) return undefined;
  const provider = options.provider;
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
  const supportedParameters = stringList(entry.supported_parameters);
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
    anthropicEffort === undefined &&
    anthropicThinking === undefined
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
  const wireShape = reasoningWireShape(provider);
  return {
    status: unsupported ? "unsupported" : supported ? "supported" : "unknown",
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(adaptive !== undefined ? { adaptive } : {}),
    ...(wireShape !== undefined ? { wireShape } : {}),
    provenance: "provider",
    refreshedAt: options.refreshedAt ?? new Date().toISOString()
  };
}

function modelId(value: ProviderRecord, key: "id" | "name" | "slug"): string | undefined {
  if (typeof value[key] !== "string") return undefined;
  const id = value[key].trim();
  if (id.length === 0) return undefined;
  return key === "name" && id.startsWith("models/") ? id.slice("models/".length) : id;
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

function architectureFromOpenRouter(entry: ProviderRecord): ModelArchitecture | undefined {
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
  entry: ProviderRecord,
  provider: string | undefined
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
    const input = inputModalities.length > 0 ? inputModalities : ["text"];
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

function decodeEntries(
  shape: ProviderDiscoveryResponseShape,
  payload: unknown,
  provider: string
): readonly unknown[] {
  if (!isRecord(payload)) {
    throw new ModelDiscoveryProtocolError(
      "invalid_payload",
      provider,
      "payload must be an object",
      payload
    );
  }
  const field = shape === "openai" || shape === "anthropic" ? "data" : "models";
  if (!Array.isArray(payload[field])) {
    throw new ModelDiscoveryProtocolError(
      "missing_model_array",
      provider,
      `"${field}" must be an array`,
      payload[field]
    );
  }
  return payload[field];
}

export function decodeModelDiscovery(
  shape: ProviderDiscoveryResponseShape,
  payload: unknown,
  options: DecodeModelDiscoveryOptions = {}
): DiscoveredProviderModel[] {
  const provider = options.provider ?? shape;
  const entries = decodeEntries(shape, payload, provider);
  const key = shape === "google" ? "name" : shape === "codex" ? "slug" : "id";
  const refreshedAt = options.refreshedAt ?? new Date().toISOString();
  const seen = new Set<string>();
  const models: DiscoveredProviderModel[] = [];
  const diagnostic = (
    code: ModelDiscoveryDiagnosticCode,
    index: number,
    message: string
  ): void => options.onDiagnostic?.({ code, provider, index, message });
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      diagnostic("invalid_model", index, "model entry must be an object");
      continue;
    }
    const id = modelId(entry, key);
    if (id === undefined) {
      diagnostic("invalid_model", index, `model "${key}" must be a non-empty string`);
      continue;
    }
    if (seen.has(id)) {
      diagnostic("duplicate_model", index, `duplicate model "${id}" was ignored`);
      continue;
    }
    if (provider === "codex" && entry.supported_in_api === false) {
      diagnostic("provider_hidden_model", index, `provider-hidden model "${id}" was ignored`);
      continue;
    }
    seen.add(id);
    const capabilities = isRecord(entry.capabilities)
      ? Object.fromEntries(
          Object.entries(entry.capabilities).flatMap(([name, value]) =>
            typeof value === "string" ? [[name, value]] : []
          )
        )
      : undefined;
    const reasoning = decodeReasoningCapabilities(entry, {
      provider,
      refreshedAt
    });
    const metadata = discoveredMetadata(entry, provider);
    const createdAt = createdAtSeconds(entry.created ?? entry.created_at);
    const preference = provider === "codex" ? providerPriority(entry.priority) : undefined;
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
    throw new ModelDiscoveryProtocolError(
      "no_usable_models",
      provider,
      `returned no usable ${shape} models`,
      payload
    );
  }
  return models;
}
