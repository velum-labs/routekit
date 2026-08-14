import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import { Effect } from "effect";

import type { BackendRequest, BackendRequestOptions } from "./backend.js";
import type { ProviderId, ProviderSource } from "./provider-source.js";

function immutableSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableSnapshot(entry))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, immutableSnapshot(entry)])
    );
    return Object.freeze(clone) as T;
  }
  return value;
}

export type ModelCatalogEntry = ModelSelectionSignals & {
  readonly publicId: string;
  readonly nativeId: string;
  readonly provider: ProviderId;
  readonly capabilities: Readonly<Record<string, string>>;
  readonly metadata?: ModelCapabilityMetadata;
  readonly reasoning?: ModelReasoningCapabilities;
};

/** Immutable model inventory. It owns discovery results, not provider resources. */
export class ModelCatalog {
  readonly #entries: ReadonlyMap<string, ModelCatalogEntry>;

  constructor(entries: Iterable<readonly [string, ModelCatalogEntry]>) {
    this.#entries = new Map(
      [...entries].map(([id, entry]) => [
        id,
        Object.freeze({
          ...entry,
          capabilities: immutableSnapshot(entry.capabilities),
          ...(entry.metadata !== undefined ? { metadata: immutableSnapshot(entry.metadata) } : {}),
          ...(entry.reasoning !== undefined
            ? { reasoning: immutableSnapshot(entry.reasoning) }
            : {})
        })
      ])
    );
  }

  ids(): readonly string[] {
    return Object.freeze([...this.#entries.keys()]);
  }

  get(id: string): ModelCatalogEntry | undefined {
    return this.#entries.get(id);
  }

  entries(): readonly ModelCatalogEntry[] {
    return Object.freeze([...this.#entries.values()]);
  }
}

/** Pure model identity resolution over an immutable catalog. */
export class ModelResolver {
  constructor(
    readonly catalog: ModelCatalog,
    readonly defaultModel: string | undefined
  ) {}

  resolve(requested: string | undefined): ModelCatalogEntry | undefined {
    const id = requested ?? this.defaultModel;
    return id === undefined ? undefined : this.catalog.get(id);
  }

  resolveNative(requested: string, provider: string): ModelCatalogEntry | undefined {
    for (const entry of this.catalog.entries()) {
      if (entry.provider === provider && entry.nativeId === requested) return entry;
    }
    return undefined;
  }
}

/** Admission policy used while constructing a catalog. */
export class RoutePolicy {
  constructor(readonly allows: (canonicalModel: string) => boolean) {}

  admit(canonicalModel: string): boolean {
    return this.allows(canonicalModel);
  }
}

/** A fully resolved, immutable execution decision. */
export type RoutePlan = Readonly<{
  publicModel: string;
  nativeModel: string;
  provider: ProviderId;
  metadata?: ModelCapabilityMetadata;
  reasoning?: ModelReasoningCapabilities;
}>;

/** Converts model intent into a final route without performing I/O. */
export class RoutePlanner {
  constructor(readonly resolver: ModelResolver) {}

  plan(requested: string | undefined, nativeProvider?: string): RoutePlan | undefined {
    const entry =
      requested !== undefined && nativeProvider !== undefined
        ? (this.resolver.catalog.get(requested) ??
          this.resolver.resolveNative(requested, nativeProvider))
        : this.resolver.resolve(requested);
    if (entry === undefined) return undefined;
    return Object.freeze({
      publicModel: entry.publicId,
      nativeModel: entry.nativeId,
      provider: entry.provider,
      ...(entry.metadata !== undefined ? { metadata: immutableSnapshot(entry.metadata) } : {}),
      ...(entry.reasoning !== undefined ? { reasoning: immutableSnapshot(entry.reasoning) } : {})
    });
  }
}

/** The sole port that performs provider request I/O for an already committed plan. */
export class BackendExecutor {
  readonly #sources: ReadonlyMap<ProviderId, ProviderSource>;

  constructor(sources: readonly ProviderSource[]) {
    this.#sources = new Map(sources.map((source) => [source.sourceId, source]));
  }

  #source(plan: RoutePlan): ProviderSource {
    const source = this.#sources.get(plan.provider);
    if (source === undefined) {
      throw new Error(`provider source "${plan.provider}" is not registered`);
    }
    return source;
  }

  supportsResponses(plan: RoutePlan): boolean {
    const source = this.#source(plan);
    return source.responses.kind === "responses" && source.responses.supports(plan.nativeModel);
  }

  chat(
    plan: RoutePlan,
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): BackendRequest {
    return this.#source(plan).requests.chat(body, signal, options);
  }

  responses(
    plan: RoutePlan,
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): BackendRequest {
    const source = this.#source(plan);
    if (source.responses.kind === "unsupported") {
      return Effect.succeed(
        Response.json(
          { error: { type: "not_supported", message: "native Responses egress is not supported" } },
          { status: 501 }
        )
      );
    }
    return source.responses.execute(body, signal, options);
  }

  embeddings(
    plan: RoutePlan,
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): BackendRequest {
    return this.#source(plan).requests.embeddings(body, signal, options);
  }
}

/** Explicit owner of provider resources and their live health probes. */
export class ProviderLifecycle {
  readonly #sources: readonly ProviderSource[];

  constructor(sources: readonly ProviderSource[]) {
    this.#sources = Object.freeze([...sources]);
  }

  statuses(catalog: ModelCatalog, signal?: AbortSignal) {
    return Effect.forEach(
      this.#sources,
      (source) =>
        source.discovery.discoverModels(signal).pipe(
          Effect.match({
            onFailure: (error) => ({
              provider: source.sourceId,
              ok: false,
              models: [] as string[],
              error: error instanceof Error ? error.message : String(error)
            }),
            onSuccess: (models) => {
              if (models.length === 0) {
                return {
                  provider: source.sourceId,
                  ok: false,
                  models: [] as string[],
                  error: "live discovery returned no models"
                };
              }
              return {
                provider: source.sourceId,
                ok: true,
                models: models
                  .map((model) => `${source.sourceId}/${model.id}`)
                  .filter((model) => catalog.get(model) !== undefined)
              };
            }
          })
        ),
      { concurrency: "unbounded" }
    );
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      this.#sources.map(async (source) => {
        if (source.resource.kind === "owned") await source.resource.close();
      })
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length > 0) throw new AggregateError(errors, "provider cleanup failed");
  }
}
