import {
  type CodexModelCandidate,
  type CodexStartupSelection,
  codexCompatibility,
  type ModelArchitecture,
  type ModelCapabilityMetadata,
  type ModelSelectionSignals,
  selectCodexStartupModel
} from "@velum-labs/routekit-contracts";
import {
  executeWebRequest,
  RouteKitFailure,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Deferred, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

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

function failOnCallerAbort<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal?: AbortSignal
): Effect.Effect<A, E, R> {
  if (signal === undefined) return effect;
  return Effect.suspend(() => {
    if (signal.aborted) {
      const reason = signal.reason;
      return Effect.fail((reason instanceof Error ? reason : routeKitError(reason)) as E);
    }
    return Effect.raceFirst(
      effect,
      Effect.callback<never, E>((resume, interruptionSignal) => {
        const abort = (): void => {
          const reason = signal.reason;
          resume(Effect.fail((reason instanceof Error ? reason : routeKitError(reason)) as E));
        };
        signal.addEventListener("abort", abort, { once: true });
        interruptionSignal.addEventListener(
          "abort",
          () => signal.removeEventListener("abort", abort),
          { once: true }
        );
        if (signal.aborted) abort();
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      })
    );
  });
}

export class OpenRouterModelMetadataClient {
  readonly #now: () => number;
  readonly #freshMs: number;
  readonly #staleMs: number;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;
  #cache: CacheEntry | undefined;
  #inflight: Deferred.Deferred<ReadonlyMap<string, OpenRouterModelMetadata>, Error> | undefined;

  constructor(options: OpenRouterModelMetadataClientOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
  }

  models(
    signal?: AbortSignal
  ): Effect.Effect<ReadonlyMap<string, OpenRouterModelMetadata>, Error, HttpClient.HttpClient> {
    const self = this;
    return failOnCallerAbort(
      Effect.gen(function* () {
        const cache = self.#cache;
        if (cache !== undefined && self.#now() - cache.fetchedAt <= self.#freshMs) {
          return cache.models;
        }
        if (self.#inflight === undefined) {
          const slot = Deferred.makeUnsafe<ReadonlyMap<string, OpenRouterModelMetadata>, Error>();
          self.#inflight = slot;
          return yield* self.#refresh(signal).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (self.#inflight === slot) self.#inflight = undefined;
              }).pipe(Effect.andThen(Deferred.done(slot, exit)))
            )
          );
        }
        return yield* Deferred.await(self.#inflight);
      }).pipe(
        Effect.catch((error) => {
          if (signal?.aborted === true) {
            const reason = signal.reason;
            return Effect.fail(reason instanceof Error ? reason : routeKitError(reason));
          }
          const stale = self.#cache;
          if (stale !== undefined && self.#now() - stale.fetchedAt <= self.#staleMs) {
            return Effect.succeed(stale.models);
          }
          return Effect.fail(error);
        })
      ),
      signal
    );
  }

  #refresh(
    caller?: AbortSignal
  ): Effect.Effect<ReadonlyMap<string, OpenRouterModelMetadata>, Error, HttpClient.HttpClient> {
    const self = this;
    return Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const combined = AbortSignal.any(caller === undefined ? [signal] : [signal, caller]);
        const settled = yield* Effect.all(
          TASK_CATALOGS.map((catalog) =>
            self.#fetchCatalog(catalog, combined).pipe(
              Effect.match({
                onFailure: (error) => ({ status: "rejected" as const, reason: error }),
                onSuccess: (value) => ({ status: "fulfilled" as const, value })
              })
            )
          ),
          { concurrency: "unbounded" }
        );
        const responses = settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        );
        if (responses.length === 0) {
          const firstFailure = settled.find(
            (result): result is { status: "rejected"; reason: Error } =>
              result.status === "rejected"
          );
          return yield* Effect.fail(
            firstFailure?.reason ??
              new RouteKitFailure({ message: "OpenRouter returned no usable model catalogs" })
          );
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
        if (normalized.size === 0) {
          return yield* new RouteKitFailure({
            message: "OpenRouter returned no usable model metadata"
          });
        }
        self.#cache = { fetchedAt: self.#now(), models: normalized };
        return normalized;
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: self.#timeoutMs,
        orElse: () =>
          Effect.fail(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      })
    );
  }

  #fetchCatalog(
    catalog: (typeof TASK_CATALOGS)[number],
    signal: AbortSignal
  ): Effect.Effect<
    {
      kind: (typeof TASK_CATALOGS)[number]["kind"];
      entries: ReadonlyArray<readonly [string, OpenRouterModelMetadata]>;
    },
    Error,
    HttpClient.HttpClient
  > {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* executeWebRequest(`${self.#baseUrl}${catalog.path}`, {
        headers: { accept: "application/json" },
        signal
      }).pipe(
        Effect.mapError((error) => {
          const cause = error.reason._tag === "TransportError" ? error.reason.cause : undefined;
          return cause instanceof Error ? cause : routeKitError(error);
        })
      );
      if (!response.ok) {
        return yield* new RouteKitFailure({
          message: `OpenRouter ${catalog.path} returned HTTP ${response.status}`
        });
      }
      const payload = record(
        yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => toRouteKitFailure(cause)
        })
      );
      if (!Array.isArray(payload?.data)) {
        return yield* new RouteKitFailure({
          message: `OpenRouter ${catalog.path} returned an invalid model catalog`
        });
      }
      return {
        kind: catalog.kind,
        entries: payload.data.flatMap((entry) => {
          const parsed = metadataFromEntry(entry, catalog);
          return parsed === undefined ? [] : [parsed];
        })
      };
    });
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

function selectStartupModel(
  input: Parameters<typeof selectCodexStartupModel>[0]
): Effect.Effect<ReturnType<typeof selectCodexStartupModel>, RouteKitFailure> {
  return Effect.try({
    try: () => selectCodexStartupModel(input),
    catch: (cause) => toRouteKitFailure(cause)
  });
}

export function resolveCodexStartupModel(
  input: {
    models: readonly CodexModelCandidate[];
    preferredModel?: string;
    requestedModel?: string;
    signal?: AbortSignal;
  },
  dependencies: { openRouter?: OpenRouterModelMetadataClient } = {}
): Effect.Effect<ResolvedCodexStartupSelection, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (input.requestedModel !== undefined) {
      const selection = yield* selectStartupModel(input);
      return { ...selection, models: input.models };
    }

    const preferred =
      input.preferredModel === undefined
        ? undefined
        : input.models.find((model) => model.id === input.preferredModel);
    if (preferred !== undefined && codexCompatibility(preferred).status === "compatible") {
      const selection = yield* selectStartupModel(input);
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
      const metadata = yield* (dependencies.openRouter ?? sharedOpenRouterMetadataClient())
        .models(input.signal)
        .pipe(
          Effect.mapError(
            (error) =>
              new RouteKitFailure({
                message:
                  "routekit codex could not verify OpenAI model compatibility and recency because " +
                  "OpenRouter model metadata is unavailable. Retry, or select a model explicitly " +
                  "with `routekit codex <provider/model>`.",
                cause: error
              })
          )
        );
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
    const selection = yield* selectStartupModel({
      models,
      ...(input.preferredModel !== undefined ? { preferredModel: input.preferredModel } : {})
    });
    return { ...selection, models };
  });
}
