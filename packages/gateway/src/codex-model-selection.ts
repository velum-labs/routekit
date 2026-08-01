import {
  codexCompatibility,
  type CodexModelCandidate,
  selectCodexStartupModel,
  type CodexStartupSelection,
  type ModelArchitecture,
  type ModelCapabilityMetadata
} from "@velum-labs/routekit-contracts";

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
  models: ReadonlyMap<string, ModelCapabilityMetadata>;
};

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

function metadataFromEntry(
  value: unknown,
  catalog: (typeof TASK_CATALOGS)[number]
): readonly [string, ModelCapabilityMetadata] | undefined {
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
    const aborted = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
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
  #inFlight: Promise<ReadonlyMap<string, ModelCapabilityMetadata>> | undefined;

  constructor(options: OpenRouterModelMetadataClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
  }

  async models(signal?: AbortSignal): Promise<ReadonlyMap<string, ModelCapabilityMetadata>> {
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

  async #refresh(): Promise<ReadonlyMap<string, ModelCapabilityMetadata>> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const settled = await Promise.allSettled(
      TASK_CATALOGS.map(async (catalog) => {
        const response = await this.#fetch(`${this.#baseUrl}${catalog.path}`, {
          headers: { accept: "application/json" },
          signal: timeout
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
    const responses = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (responses.length === 0) {
      const firstFailure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      throw firstFailure?.reason ?? new Error("OpenRouter returned no usable model catalogs");
    }
    const normalized = new Map<string, ModelCapabilityMetadata>();
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

const sharedOpenRouterMetadata = new OpenRouterModelMetadataClient();

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

  let models = input.models;
  const ambiguousOpenAi = models.some(
    (model) =>
      model.provider === "openai" && codexCompatibility(model).status === "unknown"
  );
  if (ambiguousOpenAi) {
    let metadata: ReadonlyMap<string, ModelCapabilityMetadata>;
    try {
      metadata = await (dependencies.openRouter ?? sharedOpenRouterMetadata).models(input.signal);
    } catch (error) {
      throw new Error(
        "routekit codex could not verify OpenAI model compatibility because OpenRouter " +
          "model metadata is unavailable. Retry, or select a model explicitly " +
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
