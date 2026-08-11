import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";

import type { BackendRequestOptions } from "./backend.js";
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
  readonly source: ProviderSource;
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
          ...(entry.metadata !== undefined
            ? { metadata: immutableSnapshot(entry.metadata) }
            : {}),
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
  source: ProviderSource;
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
      source: entry.source,
      ...(entry.metadata !== undefined
        ? { metadata: immutableSnapshot(entry.metadata) }
        : {}),
      ...(entry.reasoning !== undefined
        ? { reasoning: immutableSnapshot(entry.reasoning) }
        : {})
    });
  }
}

/** The sole port that performs provider request I/O for an already committed plan. */
export class BackendExecutor {
  chat(
    plan: RoutePlan,
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return plan.source.chat(body, signal, options);
  }

  responses(
    plan: RoutePlan,
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    if (plan.source.responses === undefined) {
      return Promise.resolve(
        Response.json(
          { error: { type: "not_supported", message: "native Responses egress is not supported" } },
          { status: 501 }
        )
      );
    }
    return plan.source.responses(body, signal, options);
  }

  embeddings(
    plan: RoutePlan,
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return plan.source.embeddings(body, signal, options);
  }
}

/** Explicit owner of provider resources and their live health probes. */
export class ProviderLifecycle {
  readonly #sources: readonly ProviderSource[];

  constructor(sources: readonly ProviderSource[]) {
    this.#sources = Object.freeze([...sources]);
  }

  async statuses(
    catalog: ModelCatalog,
    signal?: AbortSignal
  ): Promise<Array<{ provider: string; ok: boolean; models: string[]; error?: string }>> {
    return await Promise.all(
      this.#sources.map(async (source) => {
        try {
          const models = await source.discoverModels(signal);
          if (models.length === 0) {
            return {
              provider: source.sourceId,
              ok: false,
              models: [],
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
        } catch (error) {
          return {
            provider: source.sourceId,
            ok: false,
            models: [],
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      this.#sources.map(async (source) => await source.close?.())
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length > 0) throw new AggregateError(errors, "provider cleanup failed");
  }
}
