import {
  type CodexModelCandidate,
  type CodexStartupSelection,
  codexCompatibility,
  type ModelArchitecture,
  type ModelCapabilityMetadata,
  type ModelSelectionSignals,
  selectCodexStartupModel
} from "@velum-labs/routekit-contracts";
import { fetchViaHttpClient } from "@velum-labs/routekit-runtime/effect";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const TASK_CATALOGS = [
  { path: "/models", kind: "generation", output: undefined },
  { path: "/embeddings/models", kind: "non-generation", output: "embeddings" },
  { path: "/images/models", kind: "non-generation", output: "image" },
  { path: "/videos/models", kind: "non-generation", output: "video" }
] as const;
const DEFAULT_FRESH_MS = 5 * 60_000;
const DEFAULT_STALE_MS = 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

type CacheEntry = {
  fetchedAt: number;
  models: ReadonlyMap<string, OpenRouterModelMetadata>;
};

export type OpenRouterModelMetadata = ModelCapabilityMetadata &
  Pick<ModelSelectionSignals, "createdAt">;

export type OpenRouterModelMetadataClientOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  freshMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : [];
}

function createdAtSeconds(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function metadataFromEntry(
  value: unknown,
  catalog: (typeof TASK_CATALOGS)[number]
): readonly [string, OpenRouterModelMetadata] | undefined {
  const entry = record(value);
  if (entry === undefined || typeof entry.id !== "string") return undefined;
  const architecture = record(entry.architecture);
  const inputModalities = stringList(architecture?.input_modalities);
  const advertisedOutputs = stringList(architecture?.output_modalities);
  const outputModalities =
    advertisedOutputs.length > 0
      ? advertisedOutputs
      : catalog.output === undefined
        ? []
        : [catalog.output];
  const supportedParameters =
    catalog.kind === "generation" ? stringList(entry.supported_parameters) : [];
  const hasSupportedParameters =
    catalog.kind === "generation" && Array.isArray(entry.supported_parameters);
  const normalizedArchitecture: ModelArchitecture = {
    ...(typeof architecture?.modality === "string" || architecture?.modality === null
      ? { modality: architecture.modality }
      : {}),
    inputModalities,
    outputModalities
  };
  return [
    entry.id,
    {
      ...(createdAtSeconds(entry.created) !== undefined
        ? { createdAt: createdAtSeconds(entry.created) }
        : {}),
      architecture: normalizedArchitecture,
      ...(hasSupportedParameters ? { supportedParameters } : {}),
      provenance: "openrouter-live"
    }
  ];
}

async function withCallerCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

export class OpenRouterModelMetadataClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #freshMs: number;
  readonly #staleMs: number;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;
  #cache: CacheEntry | undefined;
  #inFlight: Promise<ReadonlyMap<string, OpenRouterModelMetadata>> | undefined;

  constructor(options: OpenRouterModelMetadataClientOptions = {}) {
    this.#fetch = options.fetch ?? ((url, init) => fetchViaHttpClient(url, init));
    this.#now = options.now ?? Date.now;
    this.#freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
  }

  async models(signal?: AbortSignal): Promise<ReadonlyMap<string, OpenRouterModelMetadata>> {
    const cache = this.#cache;
    if (cache !== undefined && this.#now() - cache.fetchedAt <= this.#freshMs) {
      return cache.models;
    }
    if (this.#inFlight !== undefined) {
      return await withCallerCancellation(this.#inFlight, signal);
    }
    const load = this.#refresh();
    this.#inFlight = load;
    void load.then(
      () => {
        if (this.#inFlight === load) this.#inFlight = undefined;
      },
      () => {
        if (this.#inFlight === load) this.#inFlight = undefined;
      }
    );
    try {
      return await withCallerCancellation(load, signal);
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? error;
      if (cache !== undefined && this.#now() - cache.fetchedAt <= this.#staleMs) {
        return cache.models;
      }
      throw error;
    }
  }

  async #refresh(): Promise<ReadonlyMap<string, OpenRouterModelMetadata>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("OpenRouter model metadata timed out", "TimeoutError"));
    }, this.#timeoutMs);
    const settled = await (async () => {
      try {
        return await Promise.allSettled(
          TASK_CATALOGS.map(async (catalog) => {
            const response = await this.#fetch(`${this.#baseUrl}${catalog.path}`, {
              headers: { accept: "application/json" },
              signal: controller.signal
            });
            if (!response.ok) {
              throw new Error(`OpenRouter ${catalog.path} returned HTTP ${response.status}`);
            }
            const payload = record(await response.json());
            if (!Array.isArray(payload?.data)) {
              throw new Error(`OpenRouter ${catalog.path} returned an invalid model catalog`);
            }
            return {
              kind: catalog.kind,
              entries: payload.data.flatMap((entry) => {
                const parsed = metadataFromEntry(entry, catalog);
                return parsed === undefined ? [] : [parsed];
              })
            };
          })
        );
      } finally {
        clearTimeout(timeout);
      }
    })();
    const responses = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (responses.length === 0) {
      const firstFailure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      throw firstFailure?.reason ?? new Error("OpenRouter returned no usable model catalogs");
    }
    const normalized = new Map<string, OpenRouterModelMetadata>();
    // Non-generation entries establish a negative classification. Generation
    // wins when OpenRouter intentionally publishes a multimodal model in both.
    for (const response of responses.filter((entry) => entry.kind === "non-generation")) {
      for (const [id, metadata] of response.entries) normalized.set(id, metadata);
    }
    for (const response of responses.filter((entry) => entry.kind === "generation")) {
      for (const [id, metadata] of response.entries) normalized.set(id, metadata);
    }
    if (normalized.size === 0) throw new Error("OpenRouter returned no usable model metadata");
    this.#cache = { fetchedAt: this.#now(), models: normalized };
    return normalized;
  }
}

let sharedOpenRouterMetadata: OpenRouterModelMetadataClient | undefined;

function sharedOpenRouterMetadataClient(): OpenRouterModelMetadataClient {
  sharedOpenRouterMetadata ??= new OpenRouterModelMetadataClient();
  return sharedOpenRouterMetadata;
}

export type ResolvedCodexStartupSelection = CodexStartupSelection & {
  models: readonly CodexModelCandidate[];
};

export async function resolveCodexStartupModel(
  input: {
    models: readonly CodexModelCandidate[];
    preferredModel?: string;
    requestedModel?: string;
    signal?: AbortSignal;
  },
  dependencies: { openRouter?: OpenRouterModelMetadataClient } = {}
): Promise<ResolvedCodexStartupSelection> {
  if (input.requestedModel !== undefined) {
    const selection = selectCodexStartupModel(input);
    return { ...selection, models: input.models };
  }

  const preferred =
    input.preferredModel === undefined
      ? undefined
      : input.models.find((model) => model.id === input.preferredModel);
  if (preferred !== undefined && codexCompatibility(preferred).status === "compatible") {
    const selection = selectCodexStartupModel(input);
    return { ...selection, models: input.models };
  }

  let models = input.models;
  const billingScoped =
    preferred?.billingScope === undefined
      ? models
      : models.filter((model) => model.billingScope === preferred.billingScope);
  const hasCompatiblePreferredProvider =
    preferred?.provider !== undefined &&
    billingScoped.some(
      (model) =>
        model.provider === preferred.provider && codexCompatibility(model).status === "compatible"
    );
  const fallbackScope = hasCompatiblePreferredProvider
    ? billingScoped.filter((model) => model.provider === preferred?.provider)
    : billingScoped;
  const openAiNeedsMetadata = fallbackScope.some((model) => {
    if (model.provider !== "openai") return false;
    const status = codexCompatibility(model).status;
    return status === "unknown" || (status === "compatible" && model.createdAt === undefined);
  });
  if (openAiNeedsMetadata) {
    let metadata: ReadonlyMap<string, OpenRouterModelMetadata>;
    try {
      metadata = await (dependencies.openRouter ?? sharedOpenRouterMetadataClient()).models(
        input.signal
      );
    } catch (error) {
      throw new Error(
        "routekit codex could not verify OpenAI model compatibility and recency because " +
          "OpenRouter model metadata is unavailable. Retry, or select a model explicitly " +
          "with `routekit codex <provider/model>`.",
        { cause: error }
      );
    }
    models = models.map((model) => {
      if (model.provider !== "openai") return model;
      const nativeId =
        model.nativeId ??
        (model.id.startsWith("openai/") ? model.id.slice("openai/".length) : model.id);
      const discovered = metadata.get(`openai/${nativeId}`);
      return discovered === undefined
        ? model
        : {
            ...model,
            ...(model.createdAt === undefined && discovered.createdAt !== undefined
              ? { createdAt: discovered.createdAt }
              : {}),
            ...(discovered.architecture !== undefined
              ? { architecture: discovered.architecture }
              : {}),
            ...(discovered.supportedParameters !== undefined
              ? { supportedParameters: discovered.supportedParameters }
              : {})
          };
    });
  }
  const selection = selectCodexStartupModel({
    models,
    ...(input.preferredModel !== undefined ? { preferredModel: input.preferredModel } : {})
  });
  return { ...selection, models };
}
