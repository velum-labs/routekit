import { Schema } from "effect";

import { evalModelsCatalogUrl } from "../../../../../host-env.ts";

/**
 * Public Gateway catalog endpoint; needs no auth. `sort=top-weekly` ranks
 * models by tokens processed in the last week so the picker lists the most
 * used models first instead of the newest ones.
 */
const GATEWAY_MODELS_URL =
  "http://127.0.0.1:8080/v1/models?sort=top-weekly";
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

// Every catalog field below is `optionalKey` AND `NullOr`. Optional alone is not
// enough: measured against the live catalog, present-and-null is the ordinary
// case rather than an edge case (333 of 340 entries carry
// `expiration_date: null`, 181 carry `knowledge_cutoff: null`, and 10 carry
// `benchmarks.artificial_analysis.intelligence_index: null`), so an
// optional-only schema would reject most of the catalog. Excess keys are ignored
// by default, so the payload can keep growing without breaking decode.
const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optionalKey(Schema.NullOr(Schema.Number));
const NullableBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const NullableStrings = Schema.optionalKey(
  Schema.NullOr(Schema.Array(Schema.String))
);

const GatewayPricingSchema = Schema.Struct({
  audio: NullableString,
  completion: NullableString,
  image: NullableString,
  input_cache_read: NullableString,
  input_cache_write: NullableString,
  internal_reasoning: NullableString,
  prompt: NullableString,
  web_search: NullableString,
});

const GatewayArchitectureSchema = Schema.Struct({
  input_modalities: NullableStrings,
  modality: NullableString,
  output_modalities: NullableStrings,
  tokenizer: NullableString,
});

const GatewayTopProviderSchema = Schema.Struct({
  context_length: NullableNumber,
  is_moderated: NullableBoolean,
  max_completion_tokens: NullableNumber,
});

const GatewayReasoningSchema = Schema.Struct({
  default_effort: NullableString,
  mandatory: NullableBoolean,
  supported_efforts: NullableStrings,
});

const GatewayDesignArenaSchema = Schema.Struct({
  arena: NullableString,
  category: NullableString,
  elo: NullableNumber,
  rank: NullableNumber,
  win_rate: NullableNumber,
});

const GatewayAliasTargetSchema = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
});

const GatewayArtificialAnalysisSchema = Schema.Struct({
  agentic_index: NullableNumber,
  coding_index: NullableNumber,
  intelligence_index: NullableNumber,
});

const GatewayBenchmarksSchema = Schema.Struct({
  artificial_analysis: Schema.optionalKey(
    Schema.NullOr(GatewayArtificialAnalysisSchema)
  ),
  design_arena: Schema.optionalKey(
    Schema.NullOr(Schema.Array(GatewayDesignArenaSchema))
  ),
});

const GatewayModelEntrySchema = Schema.Struct({
  alias_target: Schema.optionalKey(Schema.NullOr(GatewayAliasTargetSchema)),
  architecture: Schema.optionalKey(Schema.NullOr(GatewayArchitectureSchema)),
  benchmarks: Schema.optionalKey(Schema.NullOr(GatewayBenchmarksSchema)),
  canonical_slug: NullableString,
  context_length: NullableNumber,
  created: NullableNumber,
  description: NullableString,
  expiration_date: NullableString,
  id: Schema.String,
  knowledge_cutoff: NullableString,
  name: NullableString,
  pricing: Schema.optionalKey(Schema.NullOr(GatewayPricingSchema)),
  reasoning: Schema.optionalKey(Schema.NullOr(GatewayReasoningSchema)),
  supported_parameters: NullableStrings,
  top_provider: Schema.optionalKey(Schema.NullOr(GatewayTopProviderSchema)),
});

// Entries are decoded one at a time (see `decodeGatewayModels`), so the
// envelope only has to agree that `data` is a list.
const GatewayModelsResponseSchema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
});

/** Per-token rate card for a model, as the raw decimal strings the API returns. */
interface GatewayModelPricing {
  readonly audio?: string | undefined;
  readonly completion?: string | undefined;
  readonly image?: string | undefined;
  readonly inputCacheRead?: string | undefined;
  readonly inputCacheWrite?: string | undefined;
  readonly internalReasoning?: string | undefined;
  readonly prompt?: string | undefined;
  readonly webSearch?: string | undefined;
}

/** A concrete model targeted by a tilde-latest alias. */
interface GatewayAliasTarget {
  readonly slug: string;
  readonly name: string;
}

/** What a model can take in and emit, and how it counts tokens. */
interface GatewayModelArchitecture {
  readonly inputModalities?: readonly string[] | undefined;
  readonly modality?: string | undefined;
  readonly outputModalities?: readonly string[] | undefined;
  readonly tokenizer?: string | undefined;
}

/** Reasoning support. A `mandatory` model cannot be asked to skip reasoning. */
interface GatewayModelReasoning {
  readonly defaultEffort?: string | undefined;
  readonly mandatory?: boolean | undefined;
  /** Absent means any effort may be sent; empty means send none, not guess. */
  readonly supportedEfforts?: readonly string[] | undefined;
}

/** One Design Arena placement, scoped to a category such as `svg` or `gamedev`. */
interface GatewayDesignArenaEntry {
  readonly arena?: string | undefined;
  readonly category?: string | undefined;
  readonly elo?: number | undefined;
  readonly rank?: number | undefined;
  readonly winRate?: number | undefined;
}

/**
 * Third-party quality signals. An index is absent when the model has not been
 * scored, never zero-filled, because a zero would sort an unscored model below a
 * genuinely weak one.
 */
interface GatewayModelBenchmarks {
  readonly agenticIndex?: number | undefined;
  readonly codingIndex?: number | undefined;
  readonly designArena?: readonly GatewayDesignArenaEntry[] | undefined;
  readonly intelligenceIndex?: number | undefined;
}

/**
 * A projected Gateway model. Absent stays absent: the API omits or nulls a
 * field when it has nothing to say, and collapsing that to a default would make
 * "unknown" indistinguishable from "measured and bad".
 */
interface GatewayModel {
  readonly aliasTarget?: GatewayAliasTarget | undefined;
  readonly architecture?: GatewayModelArchitecture | undefined;
  readonly benchmarks?: GatewayModelBenchmarks | undefined;
  readonly canonicalSlug?: string | undefined;
  readonly contextLength?: number | undefined;
  readonly created?: number | undefined;
  readonly description?: string | undefined;
  readonly expirationDate?: string | undefined;
  readonly id: string;
  readonly isModerated?: boolean | undefined;
  readonly knowledgeCutoff?: string | undefined;
  readonly maxCompletionTokens?: number | undefined;
  readonly name: string;
  readonly pricing?: GatewayModelPricing | undefined;
  readonly promptPrice?: string | undefined;
  /**
   * Absent or `null` both state the model does not reason: the live catalog
   * omits the key rather than sending null, so consumers must treat the two
   * spellings alike. A model missing from the catalog entirely is a separate,
   * unknown case.
   */
  readonly reasoning?: GatewayModelReasoning | null | undefined;
  readonly supportedParameters?: readonly string[] | undefined;
}

/** Capability for lazily resolving the Gateway model catalog. */
interface ModelCatalog {
  readonly listModels: () => Promise<readonly GatewayModel[]>;
}

const decodeResponse = Schema.decodeUnknownSync(GatewayModelsResponseSchema);
const decodeEntry = Schema.decodeUnknownSync(GatewayModelEntrySchema);

type DecodedEntry = typeof GatewayModelEntrySchema.Type;

/**
 * Collapse the wire's "key absent" and "key present but null" into the single
 * `undefined` the projected model exposes, so callers never check both.
 */
const present = <A>(value: A | null | undefined): A | undefined =>
  value === null ? undefined : value;

const projectPricing = (
  pricing: DecodedEntry["pricing"]
): GatewayModelPricing | undefined => {
  const rates = present(pricing);
  return rates === undefined
    ? undefined
    : {
        audio: present(rates.audio),
        completion: present(rates.completion),
        image: present(rates.image),
        inputCacheRead: present(rates.input_cache_read),
        inputCacheWrite: present(rates.input_cache_write),
        internalReasoning: present(rates.internal_reasoning),
        prompt: present(rates.prompt),
        webSearch: present(rates.web_search),
      };
};

const projectArchitecture = (
  architecture: DecodedEntry["architecture"]
): GatewayModelArchitecture | undefined => {
  const shape = present(architecture);
  return shape === undefined
    ? undefined
    : {
        inputModalities: present(shape.input_modalities),
        modality: present(shape.modality),
        outputModalities: present(shape.output_modalities),
        tokenizer: present(shape.tokenizer),
      };
};

// The only projection that keeps an explicit `null`: the picker must tell "this
// model does not reason" apart from "the catalog said nothing about it".
const projectReasoning = (
  reasoning: DecodedEntry["reasoning"]
): GatewayModelReasoning | null | undefined => {
  if (reasoning === null || reasoning === undefined) {
    return reasoning;
  }
  return {
    defaultEffort: present(reasoning.default_effort),
    mandatory: present(reasoning.mandatory),
    supportedEfforts: present(reasoning.supported_efforts),
  };
};

const projectBenchmarks = (
  benchmarks: DecodedEntry["benchmarks"]
): GatewayModelBenchmarks | undefined => {
  const shape = present(benchmarks);
  if (shape === undefined) {
    return undefined;
  }
  const analysis = present(shape.artificial_analysis);
  const arena = present(shape.design_arena);
  return {
    agenticIndex: present(analysis?.agentic_index),
    codingIndex: present(analysis?.coding_index),
    designArena: arena?.map((placement) => ({
      arena: present(placement.arena),
      category: present(placement.category),
      elo: present(placement.elo),
      rank: present(placement.rank),
      winRate: present(placement.win_rate),
    })),
    intelligenceIndex: present(analysis?.intelligence_index),
  };
};

const projectEntry = (entry: DecodedEntry): GatewayModel => {
  const topProvider = present(entry.top_provider);
  const pricing = projectPricing(entry.pricing);
  const aliasTarget = present(entry.alias_target);
  return {
    aliasTarget:
      aliasTarget === undefined
        ? undefined
        : {
            name: aliasTarget.name,
            slug: aliasTarget.slug,
          },
    architecture: projectArchitecture(entry.architecture),
    benchmarks: projectBenchmarks(entry.benchmarks),
    canonicalSlug: present(entry.canonical_slug),
    contextLength: present(entry.context_length),
    created: present(entry.created),
    description: present(entry.description),
    expirationDate: present(entry.expiration_date),
    id: entry.id,
    isModerated: present(topProvider?.is_moderated),
    knowledgeCutoff: present(entry.knowledge_cutoff),
    maxCompletionTokens: present(topProvider?.max_completion_tokens),
    name: present(entry.name) ?? entry.id,
    pricing,
    promptPrice: pricing?.prompt,
    reasoning: projectReasoning(entry.reasoning),
    supportedParameters: present(entry.supported_parameters),
  };
};

/** The chat TUI is a text surface, so the picker only offers text models. */
const TEXT_MODALITY = "text";

// A modality list qualifies when it declares `text`. An undeclared list (the
// field is absent from the entry) is treated as text-capable: the live catalog
// always declares modalities, so this fallback only covers payloads that omit
// `architecture` entirely, where assuming text is the least-surprising default
// (it keeps such entries visible rather than silently hiding the whole picker).
const includesText = (modalities: readonly string[] | undefined): boolean =>
  modalities === undefined || modalities.includes(TEXT_MODALITY);

const isTextModel = (model: GatewayModel): boolean =>
  includesText(model.architecture?.inputModalities) &&
  includesText(model.architecture?.outputModalities);

/**
 * Decode and project a raw `/models` payload into catalog models, filtered to
 * models that support text input and text output (see {@link isTextModel}).
 *
 * Entries decode one at a time so a single malformed model costs that model and
 * nothing else; decoding the whole array in one pass let one bad entry take down
 * the other 339. A payload whose entries *all* fail still throws, because an
 * empty catalog reading as "no models available" is worse than a loud failure.
 *
 * The per-entry decoder throws on mismatch instead of returning a `Result`
 * because this module is merged verbatim into the generated `routekit-eval` SDK, which is
 * handed `Schema` from `effect` and nothing else.
 */
const decodeGatewayModels = (
  payload: unknown
): readonly GatewayModel[] => {
  const entries = decodeResponse(payload).data;
  const models: GatewayModel[] = [];
  let firstFailure: unknown;
  for (const entry of entries) {
    try {
      models.push(projectEntry(decodeEntry(entry)));
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (entries.length > 0 && models.length === 0) {
    throw new Error(
      `Gateway models response carried ${entries.length} entries and none could be decoded`,
      { cause: firstFailure }
    );
  }
  return models.filter(isTextModel);
};

/** The slice of a fetch response this module needs; keeps tests free of `Response`. */
interface ModelsHttpResponse {
  readonly json: () => Promise<unknown>;
  readonly ok: boolean;
  readonly status: number;
}

/** Minimal fetch shape the catalog request depends on; the global `fetch` satisfies it. */
export type ModelsFetch = (
  url: string,
  init?: {
    readonly headers?: Readonly<Record<string, string>>;
  }
) => Promise<ModelsHttpResponse>;

/** Fetch and decode an Gateway catalog response from a supplied URL. */
export const fetchGatewayModelsRequest = async (
  fetchImpl: ModelsFetch,
  url: string,
  headers?: Readonly<Record<string, string>>
): Promise<readonly GatewayModel[]> => {
  const response = await fetchImpl(
    url,
    headers === undefined ? undefined : { headers }
  );
  if (!response.ok) {
    const authHint =
      response.status === HTTP_UNAUTHORIZED ||
      response.status === HTTP_FORBIDDEN
        ? "; your Gateway API key may be invalid or expired"
        : "";
    throw new Error(
      `Gateway models request failed with HTTP ${response.status}${authHint}`
    );
  }
  const payload: unknown = await response.json();
  return decodeGatewayModels(payload);
};

/** Fetch the public Gateway catalog. `fetchImpl` is injectable for tests. */
export const fetchGatewayModels = (
  fetchImpl: ModelsFetch = fetch
): Promise<readonly GatewayModel[]> =>
  fetchGatewayModelsRequest(fetchImpl, evalModelsCatalogUrl());

export { GATEWAY_MODELS_URL, decodeGatewayModels };
export type {
  ModelsHttpResponse,
  ModelCatalog,
  GatewayAliasTarget,
  GatewayDesignArenaEntry,
  GatewayModel,
  GatewayModelArchitecture,
  GatewayModelBenchmarks,
  GatewayModelPricing,
  GatewayModelReasoning,
};
