import type {
  LunaAccuracyOutputSchema,
  LunaAccuracyPrompt,
  LunaAccuracyReasoningEffort,
  LunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import {
  lunaAccuracyVariantSerializationVersion,
  validateLunaAccuracyVariantV2,
} from "./luna-accuracy-context.ts";
import type {
  LunaAccuracyCallExecutor,
  LunaAccuracyExecutorInput,
} from "./luna-accuracy-runner.ts";
import { resolveOpenRouterKey } from "./openrouter.ts";
import type {
  AreaScore,
  ClassifierPredictionV1,
  UnknownType,
} from "./types.ts";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_LUNA_ENDPOINTS_URL =
  "https://openrouter.ai/api/v1/models/openai/gpt-5.6-luna/endpoints";

/**
 * Accuracy experiments intentionally pin Luna. Failing closed here prevents a
 * matrix typo from silently turning a Luna comparison into a model comparison.
 */
export const LUNA_ACCURACY_MODEL = "openai/gpt-5.6-luna" as const;
export const LUNA_ACCURACY_CANONICAL_MODEL =
  "openai/gpt-5.6-luna-20260709" as const;
export const LUNA_ACCURACY_PROVIDER = "OpenAI" as const;
export const LUNA_ACCURACY_PROVIDER_SLUG = "openai" as const;
export const LUNA_ACCURACY_TRANSPORT_POLICY_VERSION =
  "openrouter-openai-standard-pinned-v1" as const;

export interface LunaAccuracyTransportPolicy {
  version: typeof LUNA_ACCURACY_TRANSPORT_POLICY_VERSION;
  endpoint: typeof OPENROUTER_CHAT_COMPLETIONS_URL;
  requestedModel: typeof LUNA_ACCURACY_MODEL;
  expectedCanonicalModel: typeof LUNA_ACCURACY_CANONICAL_MODEL;
  expectedProviderName: typeof LUNA_ACCURACY_PROVIDER;
  provider: {
    order: readonly [typeof LUNA_ACCURACY_PROVIDER_SLUG];
    only: readonly [typeof LUNA_ACCURACY_PROVIDER_SLUG];
    allow_fallbacks: false;
    require_parameters: true;
  };
}

export const LUNA_ACCURACY_TRANSPORT_POLICY: LunaAccuracyTransportPolicy =
  Object.freeze({
    version: LUNA_ACCURACY_TRANSPORT_POLICY_VERSION,
    endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
    requestedModel: LUNA_ACCURACY_MODEL,
    expectedCanonicalModel: LUNA_ACCURACY_CANONICAL_MODEL,
    expectedProviderName: LUNA_ACCURACY_PROVIDER,
    provider: Object.freeze({
      order: Object.freeze([
        LUNA_ACCURACY_PROVIDER_SLUG,
      ] as const),
      only: Object.freeze([
        LUNA_ACCURACY_PROVIDER_SLUG,
      ] as const),
      allow_fallbacks: false,
      require_parameters: true,
    }),
  });

export const LUNA_ACCURACY_PREFLIGHT_VERSION =
  "openrouter-luna-catalog-preflight-v1" as const;

export const LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS = Object.freeze([
  "reasoning",
  "seed",
  "max_tokens",
  "response_format",
  "structured_outputs",
] as const);

export interface LunaAccuracyOpenRouterPreflight {
  schemaVersion: 1;
  preflightVersion: typeof LUNA_ACCURACY_PREFLIGHT_VERSION;
  checkedAt: string;
  requestedModel: typeof LUNA_ACCURACY_MODEL;
  canonicalModel: typeof LUNA_ACCURACY_CANONICAL_MODEL;
  providerName: typeof LUNA_ACCURACY_PROVIDER;
  providerTag: typeof LUNA_ACCURACY_PROVIDER_SLUG;
  endpointAvailable: true;
  requiredParameters: Array<
    typeof LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS[number]
  >;
  catalog: {
    modelsUrl: typeof OPENROUTER_MODELS_URL;
    endpointsUrl: typeof OPENROUTER_LUNA_ENDPOINTS_URL;
  };
}

export interface LunaAccuracyOpenRouterPreflightOptions {
  /** Dependency injection for unit tests. Production callers should omit it. */
  fetchImpl?: typeof fetch;
  /** Dependency injection for deterministic tests. */
  now?: () => string;
}

export interface LunaAccuracyOpenRouterPreflightBinding {
  preflightVersion: typeof LUNA_ACCURACY_PREFLIGHT_VERSION;
  requestedModel: typeof LUNA_ACCURACY_MODEL;
  canonicalModel: typeof LUNA_ACCURACY_CANONICAL_MODEL;
  providerName: typeof LUNA_ACCURACY_PROVIDER;
  providerTag: typeof LUNA_ACCURACY_PROVIDER_SLUG;
  endpointAvailable: true;
  requiredParameters: Array<
    typeof LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS[number]
  >;
  catalog: LunaAccuracyOpenRouterPreflight["catalog"];
}

const UNKNOWN_TYPES = [
  "new_repository_area",
  "outside_scope",
  "insufficient_information",
] as const satisfies readonly UnknownType[];

const STAGES = ["classify", "proposal", "verify", "revise"] as const;
export type LunaAccuracyCallStage = (typeof STAGES)[number];

export type LunaAccuracyEvidencePolarity = "support" | "counterevidence";

export interface LunaAccuracyObservableEvidence {
  id: string;
  areaId: string;
  polarity: LunaAccuracyEvidencePolarity;
  /**
   * A short, model-emitted observable fact. It is not chain-of-thought. Both
   * the JSON schema and runtime parser cap it at 500 characters.
   */
  fact: string;
}

/**
 * ClassifierPredictionV1 compatibility is retained for all existing metrics,
 * while the two confidence components remain available for calibration.
 */
export interface LunaAccuracyPredictionV2 extends ClassifierPredictionV1 {
  gateConfidence: number;
  areaConfidence: number | null;
  observableEvidence?: LunaAccuracyObservableEvidence[];
}

export interface LunaAccuracyCallMetadata {
  schemaVersion: 1;
  stage: LunaAccuracyCallStage;
  request: {
    model: typeof LUNA_ACCURACY_MODEL;
    seed: number;
    reasoningEffort: LunaAccuracyReasoningEffort;
    maxOutputTokens: number;
    outputSchema: LunaAccuracyOutputSchema;
    timeoutMs: number;
    inputCharacters: number;
    serializationVersion: string;
  };
  provider: {
    name: typeof LUNA_ACCURACY_PROVIDER;
  };
  response: {
    /**
     * OpenRouter returns the requested alias in this field. The immutable
     * canonical revision is independently attested by the public catalog
     * preflight and persisted separately by the runner.
     */
    model: typeof LUNA_ACCURACY_MODEL;
    finishReason?: string;
    nativeFinishReason?: string;
    contentCharacters: number;
    promptTokens?: number;
    cachedInputTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
  };
}

export interface LunaAccuracyCallResult {
  prediction: LunaAccuracyPredictionV2;
  /**
   * Safe operational metadata only: no API key, raw prompt, task text,
   * response text, request/response identifier, or hidden reasoning.
   */
  metadata: LunaAccuracyCallMetadata;
}

interface LunaAccuracyBaseInput {
  taskEpisodeId: string;
  prompt: LunaAccuracyPrompt;
  variant: LunaAccuracyVariantV2;
  allowedAreaIds: readonly string[];
  model?: string;
  classifierLabel?: string;
  seed?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type LunaAccuracyArchitectureStageInput =
  | (LunaAccuracyBaseInput & {
      stage: "proposal";
      proposal?: never;
      verification?: never;
    })
  | (LunaAccuracyBaseInput & {
      stage: "verify";
      proposal: LunaAccuracyPredictionV2;
      verification?: never;
    })
  | (LunaAccuracyBaseInput & {
      stage: "revise";
      proposal: LunaAccuracyPredictionV2;
      verification: LunaAccuracyPredictionV2;
    });

export type LunaAccuracyClassificationInput = LunaAccuracyBaseInput;

export interface LunaAccuracyProviderRequest {
  model: typeof LUNA_ACCURACY_MODEL;
  max_tokens: number;
  reasoning: {
    effort: LunaAccuracyReasoningEffort;
    exclude: true;
  };
  provider: {
    order: [typeof LUNA_ACCURACY_PROVIDER_SLUG];
    only: [typeof LUNA_ACCURACY_PROVIDER_SLUG];
    allow_fallbacks: false;
    require_parameters: true;
  };
  seed: number;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  response_format: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    };
  };
}

export interface LunaAccuracyOpenRouterOptions {
  /** Dependency injection for unit tests. Production callers should omit it. */
  fetchImpl?: typeof fetch;
  /**
   * Dependency injection for unit tests. Returning the key is intentionally
   * isolated from request/result metadata and error messages.
   */
  resolveApiKey?: () => Promise<string>;
}

interface EvidenceEntry {
  areaId: string;
  supportingFacts: string[];
  counterevidence: string[];
}

interface RankedCandidate extends EvidenceEntry {
  score: number;
}

interface ParsedLunaAccuracyDecision {
  known: boolean;
  selectedAreaIds: string[];
  unknownType: UnknownType | null;
  confidence: number;
  gateConfidence: number;
  areaConfidence: number | null;
  evidence?: EvidenceEntry[];
  rankedCandidates?: RankedCandidate[];
}

interface OpenRouterChatResponse {
  provider?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void => {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`Unexpected ${label} field: ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!(key in value)) {
      throw new Error(`Missing ${label} field: ${key}`);
    }
  }
};

const assertBoundedString: (
  value: unknown,
  label: string,
  maximumLength: number,
) => asserts value is string = (value, label, maximumLength) => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength
  ) {
    throw new Error(`Invalid ${label}`);
  }
};

const assertProbability: (
  value: unknown,
  label: string,
) => asserts value is number = (value, label) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`Invalid ${label}; expected a finite number in [0, 1]`);
  }
};

const assertSeed: (seed: unknown) => asserts seed is number = (seed) => {
  if (
    !Number.isInteger(seed) ||
    (seed as number) < 0 ||
    (seed as number) > 2_147_483_647
  ) {
    throw new Error("Luna accuracy seed must be an integer in [0, 2147483647]");
  }
};

const validateAllowedAreaIds = (
  areaIds: readonly string[],
): Set<string> => {
  if (!Array.isArray(areaIds) || areaIds.length < 1 || areaIds.length > 512) {
    throw new Error("Luna accuracy calls need 1..512 allowed area IDs");
  }
  const allowed = new Set<string>();
  for (const areaId of areaIds) {
    assertBoundedString(areaId, "allowed area ID", 200);
    if (/[\u0000-\u001f\u007f]/u.test(areaId)) {
      throw new Error("Allowed area IDs cannot contain control characters");
    }
    if (allowed.has(areaId)) {
      throw new Error(`Duplicate allowed area ID: ${areaId}`);
    }
    allowed.add(areaId);
  }
  return allowed;
};

const commonSchemaProperties = (
  allowedAreaIds: readonly string[],
): Record<string, unknown> => ({
  known: { type: "boolean" },
  selected_area_ids: {
    type: "array",
    maxItems: 2,
    items: { type: "string", enum: [...allowedAreaIds] },
  },
  unknown_type: {
    anyOf: [
      { type: "string", enum: [...UNKNOWN_TYPES] },
      { type: "null" },
    ],
  },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  gate_confidence: { type: "number", minimum: 0, maximum: 1 },
  area_confidence: {
    anyOf: [
      { type: "number", minimum: 0, maximum: 1 },
      { type: "null" },
    ],
  },
});

const evidenceItemSchema = (
  allowedAreaIds: readonly string[],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["area_id", "supporting_facts", "counterevidence"],
  properties: {
    area_id: { type: "string", enum: [...allowedAreaIds] },
    supporting_facts: {
      type: "array",
      maxItems: 4,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    counterevidence: {
      type: "array",
      maxItems: 4,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
});

export const buildLunaAccuracyResponseSchema = (
  outputSchema: LunaAccuracyOutputSchema,
  allowedAreaIds: readonly string[],
): Record<string, unknown> => {
  validateAllowedAreaIds(allowedAreaIds);
  const commonRequired = [
    "known",
    "selected_area_ids",
    "unknown_type",
    "confidence",
    "gate_confidence",
    "area_confidence",
  ];
  const properties = commonSchemaProperties(allowedAreaIds);

  if (outputSchema === "minimal") {
    return {
      type: "object",
      additionalProperties: false,
      required: commonRequired,
      properties,
    };
  }
  if (outputSchema === "evidence") {
    return {
      type: "object",
      additionalProperties: false,
      required: [...commonRequired, "evidence"],
      properties: {
        ...properties,
        evidence: {
          type: "array",
          maxItems: Math.min(5, allowedAreaIds.length),
          items: evidenceItemSchema(allowedAreaIds),
        },
      },
    };
  }
  if (outputSchema !== "ranked") {
    throw new Error(`Unsupported Luna accuracy output schema: ${outputSchema}`);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: [...commonRequired, "ranked_candidates"],
    properties: {
      ...properties,
      ranked_candidates: {
        type: "array",
        maxItems: Math.min(5, allowedAreaIds.length),
        items: {
          ...evidenceItemSchema(allowedAreaIds),
          required: [
            "area_id",
            "score",
            "supporting_facts",
            "counterevidence",
          ],
          properties: {
            area_id: { type: "string", enum: [...allowedAreaIds] },
            score: { type: "number", minimum: 0, maximum: 1 },
            supporting_facts: {
              type: "array",
              maxItems: 4,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            counterevidence: {
              type: "array",
              maxItems: 4,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
      },
    },
  };
};

const parseStringList = (
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`Invalid ${label}`);
  }
  return value.map((item, index) => {
    assertBoundedString(
      item,
      `${label}[${index}]`,
      maximumItemLength,
    );
    return item;
  });
};

const parseEvidenceEntries = (
  value: unknown,
  allowedAreaIds: ReadonlySet<string>,
  ranked: boolean,
): Array<EvidenceEntry | RankedCandidate> => {
  if (
    !Array.isArray(value) ||
    value.length > Math.min(5, allowedAreaIds.size)
  ) {
    throw new Error(
      `Invalid ${ranked ? "ranked_candidates" : "evidence"} array`,
    );
  }
  const seen = new Set<string>();
  let precedingScore = Number.POSITIVE_INFINITY;
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid evidence entry at index ${index}`);
    }
    assertExactKeys(
      entry,
      ranked
        ? ["area_id", "score", "supporting_facts", "counterevidence"]
        : ["area_id", "supporting_facts", "counterevidence"],
      ranked ? "ranked candidate" : "evidence entry",
    );
    assertBoundedString(entry.area_id, "evidence area_id", 200);
    if (!allowedAreaIds.has(entry.area_id)) {
      throw new Error(`Luna invented area ID ${entry.area_id}`);
    }
    if (seen.has(entry.area_id)) {
      throw new Error(`Luna repeated evidence area ID ${entry.area_id}`);
    }
    seen.add(entry.area_id);
    const parsed: EvidenceEntry = {
      areaId: entry.area_id,
      supportingFacts: parseStringList(
        entry.supporting_facts,
        "supporting_facts",
        4,
        500,
      ),
      counterevidence: parseStringList(
        entry.counterevidence,
        "counterevidence",
        4,
        500,
      ),
    };
    if (!ranked) return parsed;
    assertProbability(entry.score, "ranked candidate score");
    if (entry.score > precedingScore) {
      throw new Error("Luna ranked candidates are not in descending order");
    }
    precedingScore = entry.score;
    return { ...parsed, score: entry.score };
  });
};

export const parseLunaAccuracyDecision = (
  content: string,
  outputSchema: LunaAccuracyOutputSchema,
  allowedAreaIds: readonly string[],
): ParsedLunaAccuracyDecision => {
  const allowed = validateAllowedAreaIds(allowedAreaIds);
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Luna returned invalid structured JSON");
  }
  if (!isRecord(raw)) {
    throw new Error("Luna returned a non-object decision");
  }
  const commonKeys = [
    "known",
    "selected_area_ids",
    "unknown_type",
    "confidence",
    "gate_confidence",
    "area_confidence",
  ];
  assertExactKeys(
    raw,
    outputSchema === "minimal"
      ? commonKeys
      : outputSchema === "evidence"
        ? [...commonKeys, "evidence"]
        : [...commonKeys, "ranked_candidates"],
    "Luna accuracy decision",
  );
  if (typeof raw.known !== "boolean") {
    throw new Error("Luna returned an invalid known flag");
  }
  const selectedAreaIds = parseStringList(
    raw.selected_area_ids,
    "selected_area_ids",
    2,
    200,
  );
  if (new Set(selectedAreaIds).size !== selectedAreaIds.length) {
    throw new Error("Luna repeated a selected area ID");
  }
  for (const areaId of selectedAreaIds) {
    if (!allowed.has(areaId)) {
      throw new Error(`Luna invented area ID ${areaId}`);
    }
  }
  const unknownType = raw.unknown_type;
  if (
    unknownType !== null &&
    (typeof unknownType !== "string" ||
      !(UNKNOWN_TYPES as readonly string[]).includes(unknownType))
  ) {
    throw new Error("Luna returned an invalid unknown_type");
  }
  assertProbability(raw.confidence, "decision confidence");
  assertProbability(raw.gate_confidence, "gate confidence");
  if (raw.area_confidence !== null) {
    assertProbability(raw.area_confidence, "area confidence");
  }

  if (raw.known) {
    if (selectedAreaIds.length < 1) {
      throw new Error("Luna marked a decision known without selecting an area");
    }
    if (unknownType !== null) {
      throw new Error("Luna returned unknown_type for a known decision");
    }
    if (raw.area_confidence === null) {
      throw new Error("Luna omitted area_confidence for a known decision");
    }
  } else {
    if (selectedAreaIds.length !== 0) {
      throw new Error("Luna selected an area for an unknown decision");
    }
    if (unknownType === null) {
      throw new Error("Luna omitted unknown_type for an unknown decision");
    }
    if (raw.area_confidence !== null) {
      throw new Error(
        "Luna returned area_confidence for an unknown decision",
      );
    }
  }

  const parsed: ParsedLunaAccuracyDecision = {
    known: raw.known,
    selectedAreaIds,
    unknownType: unknownType as UnknownType | null,
    confidence: raw.confidence,
    gateConfidence: raw.gate_confidence,
    areaConfidence: raw.area_confidence,
  };

  if (outputSchema === "evidence") {
    const evidence = parseEvidenceEntries(raw.evidence, allowed, false) as
      EvidenceEntry[];
    if (
      raw.known &&
      selectedAreaIds.some(
        (areaId) => !evidence.some((entry) => entry.areaId === areaId),
      )
    ) {
      throw new Error("Luna omitted evidence for a selected area");
    }
    parsed.evidence = evidence;
  } else if (outputSchema === "ranked") {
    const rankedCandidates = parseEvidenceEntries(
      raw.ranked_candidates,
      allowed,
      true,
    ) as RankedCandidate[];
    if (
      raw.known &&
      selectedAreaIds.some(
        (areaId, index) => rankedCandidates[index]?.areaId !== areaId,
      )
    ) {
      throw new Error(
        "Luna selected areas do not match its leading ranked candidates",
      );
    }
    parsed.rankedCandidates = rankedCandidates;
  }
  return parsed;
};

const observableEvidence = (
  entries: readonly EvidenceEntry[],
  prefix: string,
): LunaAccuracyObservableEvidence[] =>
  entries.flatMap((entry, entryIndex) => [
    ...entry.supportingFacts.map((fact, factIndex) => ({
      id: `${prefix}:${entryIndex}:support:${factIndex}`,
      areaId: entry.areaId,
      polarity: "support" as const,
      fact,
    })),
    ...entry.counterevidence.map((fact, factIndex) => ({
      id: `${prefix}:${entryIndex}:counter:${factIndex}`,
      areaId: entry.areaId,
      polarity: "counterevidence" as const,
      fact,
    })),
  ]);

const rankedAreaScores = (
  candidates: readonly RankedCandidate[],
  evidence: readonly LunaAccuracyObservableEvidence[],
): AreaScore[] =>
  candidates.map((candidate) => ({
    areaId: candidate.areaId,
    score: candidate.score,
    evidenceIds: evidence
      .filter((item) => item.areaId === candidate.areaId)
      .map((item) => item.id),
  }));

const optionalBoundedMetadataString = (
  value: unknown,
  maximumLength: number,
): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : undefined;

const optionalNonNegativeNumber = (
  value: unknown,
  label: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`OpenRouter returned invalid ${label}`);
  }
  return value;
};

const fetchPublicCatalogJson = async (
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    throw new Error("OpenRouter Luna catalog preflight request failed");
  }
  if (!response.ok) {
    throw new Error(
      `OpenRouter Luna catalog preflight HTTP ${response.status}`,
    );
  }
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    throw new Error("OpenRouter Luna catalog preflight returned invalid JSON");
  }
};

const stringArray = (
  value: unknown,
  label: string,
): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Invalid OpenRouter Luna catalog ${label}`);
  }
  return value;
};

/**
 * Verifies the public OpenRouter model and endpoint catalogs before a paid
 * experiment begins. This performs exactly two unauthenticated GET requests
 * and never sends a prompt, task, credential, or inference request.
 *
 * The check deliberately fails closed: the requested alias, canonical model
 * revision, exact standard OpenAI endpoint tag, provider identity,
 * availability, and every request parameter used by the runner must match.
 */
export const preflightLunaAccuracyOpenRouter = async (
  options: LunaAccuracyOpenRouterPreflightOptions = {},
): Promise<LunaAccuracyOpenRouterPreflight> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const checkedAt = now();
  if (!Number.isFinite(Date.parse(checkedAt))) {
    throw new Error("OpenRouter Luna catalog preflight clock is invalid");
  }
  const modelsRaw = await fetchPublicCatalogJson(
    OPENROUTER_MODELS_URL,
    fetchImpl,
  );
  if (!isRecord(modelsRaw) || !Array.isArray(modelsRaw.data)) {
    throw new Error("Invalid OpenRouter Luna model catalog");
  }
  const aliases = modelsRaw.data.filter(
    (entry) => isRecord(entry) && entry.id === LUNA_ACCURACY_MODEL,
  );
  if (aliases.length !== 1) {
    throw new Error(
      `OpenRouter Luna catalog must contain exactly one ${LUNA_ACCURACY_MODEL} alias`,
    );
  }
  const alias = aliases[0]!;
  if (
    !isRecord(alias) ||
    alias.canonical_slug !== LUNA_ACCURACY_CANONICAL_MODEL
  ) {
    throw new Error("OpenRouter Luna canonical model revision drifted");
  }

  const endpointsRaw = await fetchPublicCatalogJson(
    OPENROUTER_LUNA_ENDPOINTS_URL,
    fetchImpl,
  );
  if (
    !isRecord(endpointsRaw) ||
    !isRecord(endpointsRaw.data) ||
    endpointsRaw.data.id !== LUNA_ACCURACY_MODEL ||
    !Array.isArray(endpointsRaw.data.endpoints)
  ) {
    throw new Error("Invalid OpenRouter Luna endpoint catalog");
  }
  const standardEndpoints = endpointsRaw.data.endpoints.filter(
    (entry) => isRecord(entry) && entry.tag === LUNA_ACCURACY_PROVIDER_SLUG,
  );
  if (standardEndpoints.length !== 1) {
    throw new Error(
      "OpenRouter Luna catalog must contain exactly one standard openai endpoint",
    );
  }
  const endpoint = standardEndpoints[0]!;
  if (!isRecord(endpoint)) {
    throw new Error("Invalid OpenRouter Luna standard endpoint");
  }
  if (endpoint.provider_name !== LUNA_ACCURACY_PROVIDER) {
    throw new Error("OpenRouter Luna standard endpoint provider drifted");
  }
  if (endpoint.model_id !== LUNA_ACCURACY_MODEL) {
    throw new Error("OpenRouter Luna standard endpoint alias drifted");
  }
  if (
    typeof endpoint.name !== "string" ||
    !endpoint.name.includes(LUNA_ACCURACY_CANONICAL_MODEL)
  ) {
    throw new Error("OpenRouter Luna standard endpoint model revision drifted");
  }
  if (endpoint.status !== 0) {
    throw new Error("OpenRouter Luna standard endpoint is unavailable");
  }
  const supported = new Set(
    stringArray(
      endpoint.supported_parameters,
      "standard endpoint supported_parameters",
    ),
  );
  const missing = LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS.filter(
    (parameter) => !supported.has(parameter),
  );
  if (missing.length > 0) {
    throw new Error(
      `OpenRouter Luna standard endpoint is missing required parameters: ${missing.join(", ")}`,
    );
  }
  return {
    schemaVersion: 1,
    preflightVersion: LUNA_ACCURACY_PREFLIGHT_VERSION,
    checkedAt,
    requestedModel: LUNA_ACCURACY_MODEL,
    canonicalModel: LUNA_ACCURACY_CANONICAL_MODEL,
    providerName: LUNA_ACCURACY_PROVIDER,
    providerTag: LUNA_ACCURACY_PROVIDER_SLUG,
    endpointAvailable: true,
    requiredParameters: [...LUNA_ACCURACY_REQUIRED_PROVIDER_PARAMETERS],
    catalog: {
      modelsUrl: OPENROUTER_MODELS_URL,
      endpointsUrl: OPENROUTER_LUNA_ENDPOINTS_URL,
    },
  };
};

const parseChatResponse = (
  raw: unknown,
): {
  content: string;
  provider?: string;
  model?: string;
  finishReason?: string;
  nativeFinishReason?: string;
  promptTokens?: number;
  cachedInputTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
} => {
  if (!isRecord(raw)) {
    throw new Error("OpenRouter returned a non-object response");
  }
  const response = raw as OpenRouterChatResponse;
  if (!Array.isArray(response.choices) || response.choices.length < 1) {
    throw new Error("OpenRouter returned no choices");
  }
  const choice = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("OpenRouter returned an invalid choice");
  }
  if (choice.error !== undefined && choice.error !== null) {
    throw new Error("OpenRouter returned a choice error");
  }
  if (choice.finish_reason === "length") {
    throw new LunaAccuracyTruncatedResponseError();
  }
  if (
    choice.message.refusal !== undefined &&
    choice.message.refusal !== null
  ) {
    throw new Error("Luna refused the classification request");
  }
  const content = choice.message.content;
  if (typeof content !== "string" || content.length < 1) {
    throw new Error("Luna returned no structured content");
  }
  if (content.length > 100_000) {
    throw new Error("Luna returned unexpectedly large structured content");
  }

  const usage = response.usage;
  if (usage !== undefined && !isRecord(usage)) {
    throw new Error("OpenRouter returned invalid usage metadata");
  }
  const promptDetails = isRecord(usage?.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined;
  const completionDetails = isRecord(usage?.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;
  const provider = optionalBoundedMetadataString(response.provider, 200);
  const model = optionalBoundedMetadataString(response.model, 300);
  const finishReason = optionalBoundedMetadataString(
    choice.finish_reason,
    100,
  );
  const nativeFinishReason = optionalBoundedMetadataString(
    choice.native_finish_reason,
    100,
  );
  const promptTokens = optionalNonNegativeNumber(
    usage?.prompt_tokens,
    "prompt tokens",
  );
  const cachedInputTokens = optionalNonNegativeNumber(
    promptDetails?.cached_tokens,
    "cached input tokens",
  );
  const completionTokens = optionalNonNegativeNumber(
    usage?.completion_tokens,
    "completion tokens",
  );
  const reasoningTokens = optionalNonNegativeNumber(
    completionDetails?.reasoning_tokens,
    "reasoning tokens",
  );
  const costUsd = optionalNonNegativeNumber(usage?.cost, "cost");
  return {
    content,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(nativeFinishReason !== undefined ? { nativeFinishReason } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

const validateBaseInput = (
  input: LunaAccuracyBaseInput,
): {
  model: typeof LUNA_ACCURACY_MODEL;
  seed: number;
  timeoutMs: number;
  allowedAreaIds: Set<string>;
} => {
  validateLunaAccuracyVariantV2(input.variant);
  const model = input.model ?? LUNA_ACCURACY_MODEL;
  if (model !== LUNA_ACCURACY_MODEL) {
    throw new Error(
      `Luna accuracy experiments require ${LUNA_ACCURACY_MODEL}`,
    );
  }
  assertBoundedString(input.taskEpisodeId, "taskEpisodeId", 512);
  if (
    !isRecord(input.prompt) ||
    typeof input.prompt.system !== "string" ||
    input.prompt.system.length < 1 ||
    input.prompt.system.length > 8_000_000 ||
    typeof input.prompt.user !== "string" ||
    input.prompt.user.length < 1 ||
    input.prompt.user.length > 8_000_000
  ) {
    throw new Error("Invalid Luna accuracy prompt");
  }
  const expectedSerialization =
    lunaAccuracyVariantSerializationVersion(input.variant);
  const permittedArchitectureSerializations = new Set([
    `${expectedSerialization}/pvr/proposal-v1`,
    `${expectedSerialization}/pvr/verify-v1`,
    `${expectedSerialization}/pvr/revise-v1`,
  ]);
  if (
    input.prompt.serializationVersion !== expectedSerialization &&
    !permittedArchitectureSerializations.has(
      input.prompt.serializationVersion,
    )
  ) {
    throw new Error(
      "Luna accuracy prompt serialization does not match its variant",
    );
  }
  assertSeed(input.prompt.seed);
  if (
    !input.variant.fixedSeedList
      .slice(0, input.variant.repetitions)
      .includes(input.prompt.seed)
  ) {
    throw new Error("Luna accuracy prompt seed is not in the repetition plan");
  }
  const seed = input.seed ?? input.prompt.seed;
  assertSeed(seed);
  const timeoutMs = input.timeoutMs ?? 300_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 900_000
  ) {
    throw new Error("Luna accuracy timeoutMs must be an integer in 1..900000");
  }
  if (
    input.classifierLabel !== undefined &&
    (typeof input.classifierLabel !== "string" ||
      input.classifierLabel.length < 1 ||
      input.classifierLabel.length > 300)
  ) {
    throw new Error("Invalid Luna accuracy classifierLabel");
  }
  return {
    model,
    seed,
    timeoutMs,
    allowedAreaIds: validateAllowedAreaIds(input.allowedAreaIds),
  };
};

const validatePriorPrediction = (
  prediction: LunaAccuracyPredictionV2,
  taskEpisodeId: string,
  allowedAreaIds: ReadonlySet<string>,
  label: string,
): void => {
  if (!isRecord(prediction)) {
    throw new Error(`Invalid ${label} prediction`);
  }
  if (prediction.taskEpisodeId !== taskEpisodeId) {
    throw new Error(`${label} prediction belongs to a different task`);
  }
  if (!Array.isArray(prediction.selectedAreaIds)) {
    throw new Error(`Invalid ${label} selected areas`);
  }
  if (
    prediction.selectedAreaIds.length > 2 ||
    new Set(prediction.selectedAreaIds).size !==
      prediction.selectedAreaIds.length
  ) {
    throw new Error(`Invalid ${label} selected areas`);
  }
  for (const areaId of prediction.selectedAreaIds) {
    if (typeof areaId !== "string" || !allowedAreaIds.has(areaId)) {
      throw new Error(`Invalid ${label} selected area`);
    }
  }
  if (
    prediction.known !== (prediction.selectedAreaIds.length > 0) ||
    (prediction.known && prediction.unknownType !== undefined) ||
    (!prediction.known &&
      (prediction.unknownType === undefined ||
        !(UNKNOWN_TYPES as readonly string[]).includes(
          prediction.unknownType,
        )))
  ) {
    throw new Error(`Inconsistent ${label} semantic decision`);
  }
  assertProbability(prediction.confidence, `${label} confidence`);
  assertProbability(prediction.gateConfidence, `${label} gate confidence`);
  if (prediction.known) {
    assertProbability(prediction.areaConfidence, `${label} area confidence`);
  } else if (prediction.areaConfidence !== null) {
    throw new Error(`Unknown ${label} decision has area confidence`);
  }
  if (!Array.isArray(prediction.areaScores)) {
    throw new Error(`Invalid ${label} area scores`);
  }
  for (const score of prediction.areaScores.slice(0, 5)) {
    if (
      !isRecord(score) ||
      typeof score.areaId !== "string" ||
      !allowedAreaIds.has(score.areaId)
    ) {
      throw new Error(`Invalid ${label} ranked candidate`);
    }
    assertProbability(score.score, `${label} ranked candidate score`);
  }
};

/**
 * Deliberately projects only the semantic decision and numeric rankings. It
 * excludes task identifiers, classifier labels, prompts, evidence text,
 * abstention strings, traces, costs, and any hidden model reasoning.
 */
const projectPriorDecision = (
  prediction: LunaAccuracyPredictionV2,
): Record<string, unknown> => ({
  known: prediction.known,
  selected_area_ids: [...prediction.selectedAreaIds],
  unknown_type: prediction.known
    ? null
    : prediction.unknownType ?? "insufficient_information",
  confidence: prediction.confidence,
  gate_confidence: prediction.gateConfidence,
  area_confidence: prediction.areaConfidence,
  ranked_candidates: prediction.areaScores.slice(0, 5).map((score) => ({
    area_id: score.areaId,
    score: score.score,
  })),
});

const stageInstruction = (stage: LunaAccuracyCallStage): string => {
  if (stage === "classify") {
    return "Return the best final classification.";
  }
  if (stage === "proposal") {
    return "Architecture stage: proposal. Return the best initial classification.";
  }
  if (stage === "verify") {
    return [
      "Architecture stage: adversarial verification.",
      "Audit the supplied proposal against the original task-aware context and frozen registry.",
      "Actively check for a forced registry match, missed area, unnecessary second area, wrong unknown subtype, and evidence contradicted by exclusions.",
      "Return your independently corrected classification in the requested schema. Do not narrate the audit or emit hidden reasoning.",
    ].join("\n");
  }
  return [
    "Architecture stage: final revision.",
    "Resolve the proposal and verifier recommendation against the original task-aware context and frozen registry.",
    "Return one final classification in the requested schema. Do not mention the architecture stages, disagreement, or hidden reasoning.",
  ].join("\n");
};

const messagesForStage = (
  prompt: LunaAccuracyPrompt,
  stage: LunaAccuracyCallStage,
  proposal?: LunaAccuracyPredictionV2,
  verification?: LunaAccuracyPredictionV2,
): Array<{ role: "system" | "user"; content: string }> => {
  const prior = [
    ...(proposal
      ? [
          "",
          "[PROPOSAL DECISION]",
          JSON.stringify(projectPriorDecision(proposal)),
        ]
      : []),
    ...(verification
      ? [
          "",
          "[VERIFIER RECOMMENDATION]",
          JSON.stringify(projectPriorDecision(verification)),
        ]
      : []),
  ];
  return [
    {
      role: "system",
      content: `${prompt.system}\n\n${stageInstruction(stage)}`,
    },
    {
      role: "user",
      content: [prompt.user, ...prior].join("\n"),
    },
  ];
};

/**
 * Builds exactly the JSON body sent to OpenRouter, excluding transport-only
 * values such as credentials, headers, timeouts, and abort signals.
 *
 * Keeping this pure makes treatment-distinctness checks compare provider-
 * visible inputs rather than experiment IDs or serialization metadata that
 * never leaves the process.
 */
export const buildLunaAccuracyProviderRequest = (input: {
  model?: string;
  prompt: LunaAccuracyPrompt;
  variant: LunaAccuracyVariantV2;
  allowedAreaIds: readonly string[];
  stage?: LunaAccuracyCallStage;
  proposal?: LunaAccuracyPredictionV2;
  verification?: LunaAccuracyPredictionV2;
  seed?: number;
}): LunaAccuracyProviderRequest => {
  const stage = input.stage ?? "classify";
  if (!STAGES.includes(stage)) {
    throw new Error(`Invalid Luna accuracy stage: ${String(stage)}`);
  }
  validateLunaAccuracyVariantV2(input.variant);
  const model = input.model ?? LUNA_ACCURACY_MODEL;
  if (model !== LUNA_ACCURACY_MODEL) {
    throw new Error(
      `Luna accuracy experiments require ${LUNA_ACCURACY_MODEL}`,
    );
  }
  if (
    typeof input.prompt.system !== "string" ||
    input.prompt.system.length < 1 ||
    typeof input.prompt.user !== "string" ||
    input.prompt.user.length < 1
  ) {
    throw new Error("Invalid Luna accuracy prompt");
  }
  const allowedAreaIds = [...validateAllowedAreaIds(
    input.allowedAreaIds,
  )];
  assertSeed(input.prompt.seed);
  const seed = input.seed ?? input.prompt.seed;
  assertSeed(seed);
  if (
    !input.variant.fixedSeedList
      .slice(0, input.variant.repetitions)
      .includes(seed)
  ) {
    throw new Error("Luna accuracy seed is not in the repetition plan");
  }
  return {
    model,
    max_tokens: input.variant.maxOutputTokens,
    reasoning: {
      effort: input.variant.reasoningEffort,
      exclude: true,
    },
    provider: {
      order: [LUNA_ACCURACY_PROVIDER_SLUG],
      only: [LUNA_ACCURACY_PROVIDER_SLUG],
      allow_fallbacks: false,
      require_parameters: true,
    },
    seed,
    messages: messagesForStage(
      input.prompt,
      stage,
      input.proposal,
      input.verification,
    ),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: `luna_accuracy_${stage}_${input.variant.outputSchema}`,
        strict: true,
        schema: buildLunaAccuracyResponseSchema(
          input.variant.outputSchema,
          allowedAreaIds,
        ),
      },
    },
  };
};

const createRequestSignal = (
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeOut: () => boolean;
} => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = (): void => {
    controller.abort();
  };
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeOut: () => timedOut,
  };
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 524, 529]);
const MAXIMUM_RETRY_AFTER_MS = 30_000;

const boundedRetryAfterMs = (
  value: string | null,
  now = Date.now(),
): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return undefined;
  }
  return Math.min(MAXIMUM_RETRY_AFTER_MS, Math.round(milliseconds));
};

export class LunaAccuracyOpenRouterHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    retryAfterMs?: number,
  ) {
    super(`OpenRouter Luna accuracy HTTP ${status}`);
    this.name = "LunaAccuracyOpenRouterHttpError";
    this.status = status;
    this.retryable =
      RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

export class LunaAccuracyTruncatedResponseError extends Error {
  readonly retryable = true;

  constructor() {
    super("Luna structured response was truncated");
    this.name = "LunaAccuracyTruncatedResponseError";
  }
}

const callLunaAccuracy = async (
  input: LunaAccuracyBaseInput,
  stage: LunaAccuracyCallStage,
  proposal: LunaAccuracyPredictionV2 | undefined,
  verification: LunaAccuracyPredictionV2 | undefined,
  options: LunaAccuracyOpenRouterOptions,
): Promise<LunaAccuracyCallResult> => {
  const validated = validateBaseInput(input);
  if (proposal) {
    validatePriorPrediction(
      proposal,
      input.taskEpisodeId,
      validated.allowedAreaIds,
      "proposal",
    );
  }
  if (verification) {
    validatePriorPrediction(
      verification,
      input.taskEpisodeId,
      validated.allowedAreaIds,
      "verification",
    );
  }
  const messages = messagesForStage(
    input.prompt,
    stage,
    proposal,
    verification,
  );
  const inputCharacters = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  const requestBody = buildLunaAccuracyProviderRequest({
    model: validated.model,
    prompt: input.prompt,
    variant: input.variant,
    allowedAreaIds: input.allowedAreaIds,
    stage,
    ...(proposal ? { proposal } : {}),
    ...(verification ? { verification } : {}),
    seed: validated.seed,
  });

  const requestSignal = createRequestSignal(input.signal, validated.timeoutMs);
  const started = performance.now();
  let rawResponse: unknown;
  try {
    const key = await (options.resolveApiKey ?? resolveOpenRouterKey)();
    if (typeof key !== "string" || key.trim().length < 1) {
      throw new Error("No OpenRouter credential found");
    }
    const response = await (options.fetchImpl ?? fetch)(
      OPENROUTER_CHAT_COMPLETIONS_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://github.com/velum-labs/ori",
          "X-Title": "Ori Luna Accuracy Lab",
        },
        body: JSON.stringify(requestBody),
        signal: requestSignal.signal,
      },
    );
    if (!response.ok) {
      // Do not include the response body: provider errors can echo private
      // request material.
      throw new LunaAccuracyOpenRouterHttpError(
        response.status,
        boundedRetryAfterMs(response.headers.get("retry-after")),
      );
    }
    try {
      rawResponse = JSON.parse(await response.text());
    } catch {
      throw new Error("OpenRouter returned invalid JSON");
    }
  } catch (error) {
    if (requestSignal.signal.aborted) {
      if (requestSignal.didTimeOut()) {
        throw new Error(
          `OpenRouter Luna accuracy request timed out after ${validated.timeoutMs} ms`,
        );
      }
      throw new Error("OpenRouter Luna accuracy request was aborted");
    }
    if (
      error instanceof LunaAccuracyOpenRouterHttpError ||
      (
        error instanceof Error &&
        (
        error.message === "OpenRouter returned invalid JSON" ||
          error.message === "No OpenRouter credential found"
        )
      )
    ) {
      throw error;
    }
    throw new Error("OpenRouter Luna accuracy request failed");
  } finally {
    requestSignal.cleanup();
  }
  const durationMs = performance.now() - started;
  const response = parseChatResponse(rawResponse);
  if (response.provider !== LUNA_ACCURACY_PROVIDER) {
    throw new Error(
      `OpenRouter routed Luna accuracy to an unexpected provider: ${
        response.provider ?? "missing"
      }`,
    );
  }
  if (response.model !== LUNA_ACCURACY_MODEL) {
    throw new Error(
      `OpenRouter returned an unexpected Luna model alias: ${
        response.model ?? "missing"
      }`,
    );
  }
  const decision = parseLunaAccuracyDecision(
    response.content,
    input.variant.outputSchema,
    input.allowedAreaIds,
  );
  const evidenceEntries =
    decision.rankedCandidates ?? decision.evidence ?? [];
  const evidence = observableEvidence(
    evidenceEntries,
    decision.rankedCandidates ? "candidate" : "evidence",
  );
  const areaScores = decision.rankedCandidates
    ? rankedAreaScores(decision.rankedCandidates, evidence)
    : [];
  const prediction: LunaAccuracyPredictionV2 = {
    schemaVersion: 1,
    taskEpisodeId: input.taskEpisodeId,
    classifier:
      input.classifierLabel ??
      `llm:${validated.model}:accuracy-v2:${input.variant.id}:${stage}`,
    areaScores,
    selectedAreaIds: decision.selectedAreaIds,
    known: decision.known,
    ...(decision.known
      ? {}
      : {
          unknownType: decision.unknownType as UnknownType,
          abstentionReason: decision.unknownType as UnknownType,
        }),
    confidence: decision.confidence,
    gateConfidence: decision.gateConfidence,
    areaConfidence: decision.areaConfidence,
    ...(evidence.length > 0 ? { observableEvidence: evidence } : {}),
    durationMs,
    inputCharacters,
    ...(response.promptTokens !== undefined
      ? { inputTokens: response.promptTokens }
      : {}),
    ...(response.cachedInputTokens !== undefined
      ? { cachedInputTokens: response.cachedInputTokens }
      : {}),
    ...(response.completionTokens !== undefined
      ? { outputTokens: response.completionTokens }
      : {}),
    ...(response.reasoningTokens !== undefined
      ? { reasoningOutputTokens: response.reasoningTokens }
      : {}),
    ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
  };
  const metadata: LunaAccuracyCallMetadata = {
    schemaVersion: 1,
    stage,
    request: {
      model: validated.model,
      seed: validated.seed,
      reasoningEffort: input.variant.reasoningEffort,
      maxOutputTokens: input.variant.maxOutputTokens,
      outputSchema: input.variant.outputSchema,
      timeoutMs: validated.timeoutMs,
      inputCharacters,
      serializationVersion: input.prompt.serializationVersion,
    },
    provider: {
      name: LUNA_ACCURACY_PROVIDER,
    },
    response: {
      model: LUNA_ACCURACY_MODEL,
      ...(response.finishReason
        ? { finishReason: response.finishReason }
        : {}),
      ...(response.nativeFinishReason
        ? { nativeFinishReason: response.nativeFinishReason }
        : {}),
      contentCharacters: response.content.length,
      ...(response.promptTokens !== undefined
        ? { promptTokens: response.promptTokens }
        : {}),
      ...(response.cachedInputTokens !== undefined
        ? { cachedInputTokens: response.cachedInputTokens }
        : {}),
      ...(response.completionTokens !== undefined
        ? { completionTokens: response.completionTokens }
        : {}),
      ...(response.reasoningTokens !== undefined
        ? { reasoningTokens: response.reasoningTokens }
        : {}),
      ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
    },
  };
  return { prediction, metadata };
};

export const classifyLunaAccuracy = async (
  input: LunaAccuracyClassificationInput,
  options: LunaAccuracyOpenRouterOptions = {},
): Promise<LunaAccuracyCallResult> =>
  callLunaAccuracy(input, "classify", undefined, undefined, options);

export const classifyLunaAccuracyWithOpenRouter = classifyLunaAccuracy;

/**
 * Adapter for runLunaAccuracyExperiment(). The runner has already constructed
 * any proposal/verifier/revision prompt, so all of its stages use the same
 * strict OpenRouter call. The runner-provided signal is forwarded to cancel
 * network work when its retry timeout fires.
 */
export const createLunaAccuracyOpenRouterExecutor = (
  options: LunaAccuracyOpenRouterOptions = {},
): LunaAccuracyCallExecutor =>
  async (input: LunaAccuracyExecutorInput): Promise<LunaAccuracyCallResult> =>
    callLunaAccuracy(
      {
        taskEpisodeId: input.taskEpisodeId,
        model: input.model,
        prompt: input.prompt,
        variant: input.variant,
        allowedAreaIds: input.allowedAreaIds,
        classifierLabel: input.classifierLabel,
        seed: input.seed,
        signal: input.signal,
      },
      input.stage === "proposal"
        ? "proposal"
        : input.stage === "verify"
        ? "verify"
        : input.stage === "revise"
        ? "revise"
        : "classify",
      undefined,
      undefined,
      options,
    );

/**
 * One resumable primitive for proposal → adversarial verification → revision.
 * Every stage yields a complete prediction, so a runner can persist and resume
 * between paid calls rather than treating the architecture as one opaque call.
 */
export const callLunaAccuracyArchitectureStage = async (
  input: LunaAccuracyArchitectureStageInput,
  options: LunaAccuracyOpenRouterOptions = {},
): Promise<LunaAccuracyCallResult> => {
  if (input.stage === "proposal") {
    return callLunaAccuracy(
      input,
      "proposal",
      undefined,
      undefined,
      options,
    );
  }
  if (input.stage === "verify") {
    return callLunaAccuracy(
      input,
      "verify",
      input.proposal,
      undefined,
      options,
    );
  }
  return callLunaAccuracy(
    input,
    "revise",
    input.proposal,
    input.verification,
    options,
  );
};
