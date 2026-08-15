import { Clock, Context, Effect, Fiber, Layer, Option } from "effect";

import type { GatewayModel } from "../../../../contracts/author/src/gateway-models.ts";
import type { ReasoningEffort } from "../../../../contracts/author/src/reasoning-effort.ts";

import { effectiveEffortFor } from "../../../../contracts/author/src/reasoning-effort.ts";
import { GatewayModels } from "../gateway/models-service.ts";

const MS_PER_MINUTE = 60_000;
const CATALOG_TTL_MINUTES = 15;
const CATALOG_TTL_MS = CATALOG_TTL_MINUTES * MS_PER_MINUTE;
const FAILURE_RETRY_MS = MS_PER_MINUTE;
const LOOKUP_TIMEOUT = "3 seconds";

// Pi routes through Gateway with an `gateway/` prefix on the slug, and
// Gateway's `~` shorthand pins a provider (the claude harness's default
// model uses it); the catalog keys models by the bare `<vendor>/<model>` id.
const GATEWAY_ROUTING_PREFIX = "gateway/";
const GATEWAY_PIN_PREFIX = "~";

const catalogModelId = (model: string): string => {
  const routed = model.startsWith(GATEWAY_ROUTING_PREFIX)
    ? model.slice(GATEWAY_ROUTING_PREFIX.length)
    : model;
  return routed.startsWith(GATEWAY_PIN_PREFIX)
    ? routed.slice(GATEWAY_PIN_PREFIX.length)
    : routed;
};

interface CatalogFacts {
  /** Every id the catalog listed, so an unlisted one reads as unknown. */
  readonly known: ReadonlySet<string>;
  /** The effective level per listed id; absent means the model cannot reason. */
  readonly efforts: ReadonlyMap<string, ReasoningEffort>;
  readonly windows: ReadonlyMap<string, number>;
}

interface CatalogSnapshot extends CatalogFacts {
  readonly fetchedAt: number;
}

interface ContextWindowLookupShape {
  readonly lookup: (
    model?: string | null
  ) => Effect.Effect<number | undefined, never, GatewayModels>;
  /**
   * The level this model should run at when nobody picked one. `undefined`
   * means the catalog never loaded or has never heard of the id, so the caller
   * keeps its own default; `null` means the entry says it cannot reason.
   */
  readonly effortFor: (
    model?: string | null
  ) => Effect.Effect<
    ReasoningEffort | null | undefined,
    never,
    GatewayModels
  >;
}

// Mutable cache state for one lookup instance. Plain object rather than a `Ref`:
// the daemon runs this on a single fiber, so there is no contention. One
// instance per {@link ContextWindowLookup} provision, so the state cannot
// outlive the layer that owns it.
interface CatalogCache {
  // The in-flight refresh fiber, shared so concurrent lookups within one TTL
  // window coalesce onto a single catalog fetch (the daemon is single-fibered,
  // but a `/model` change plus an active turn can both trigger a lookup).
  pending: Fiber.Fiber<CatalogFacts> | undefined;
  snapshot: CatalogSnapshot | undefined;
}

// Mirrors the picker's policy in chat-tui's `supportedEffortsFor`, so a headless
// caller and the TUI agree on what "reasons" means. The catalog omits
// `reasoning` for models that do not reason rather than sending null, and a
// published list whose values are all unrecognized leaves nothing to send.
const buildFacts = (models: readonly GatewayModel[]): CatalogFacts => {
  const windows = new Map<string, number>();
  const known = new Set<string>();
  const efforts = new Map<string, ReasoningEffort>();
  for (const model of models) {
    known.add(model.id);
    if (model.contextLength !== undefined) {
      windows.set(model.id, model.contextLength);
    }
    // Same policy the chat picker applies, from the same function, so a
    // headless run and the TUI cannot disagree about a model's level.
    const effort = effectiveEffortFor(model.reasoning, true);
    if (effort !== undefined) {
      efforts.set(model.id, effort);
    }
  }
  return {
    efforts,
    known,
    windows,
  };
};

const EMPTY_FACTS: CatalogFacts = {
  known: new Set<string>(),
  efforts: new Map<string, ReasoningEffort>(),
  windows: new Map<string, number>(),
};

const loadFacts = GatewayModels.pipe(
  Effect.flatMap((service) => service.fetchCatalog),
  Effect.map(buildFacts)
);

const recordFailure = (cache: CatalogCache, now: number): CatalogFacts => {
  // Remember the failure so a flaky network is retried at most once a minute
  // instead of on every turn.
  cache.snapshot = {
    fetchedAt: now - CATALOG_TTL_MS + FAILURE_RETRY_MS,
    efforts: cache.snapshot?.efforts ?? EMPTY_FACTS.efforts,
    known: cache.snapshot?.known ?? EMPTY_FACTS.known,
    windows: cache.snapshot?.windows ?? EMPTY_FACTS.windows,
  };
  return cache.snapshot;
};

const refresh = (
  cache: CatalogCache,
  now: number
): Effect.Effect<Fiber.Fiber<CatalogFacts>, never, GatewayModels> =>
  Effect.sync(() => cache.pending).pipe(
    Effect.flatMap((existing) =>
      existing === undefined
        ? loadFacts.pipe(
            Effect.map((facts) => {
              cache.snapshot = {
                fetchedAt: now,
                ...facts,
              };
              return facts;
            }),
            Effect.catchCause(() =>
              Effect.sync(() => recordFailure(cache, now))
            ),
            // Clear the shared fiber once done so the next TTL miss refetches.
            Effect.ensuring(Effect.sync(() => (cache.pending = undefined))),
            Effect.forkDetach,
            Effect.tap((fiber) => Effect.sync(() => (cache.pending = fiber)))
          )
        : Effect.succeed(existing)
    )
  );

const factsEffect = (
  cache: CatalogCache,
  now: number
): Effect.Effect<CatalogFacts, never, GatewayModels> =>
  cache.snapshot !== undefined &&
  now - cache.snapshot.fetchedAt < CATALOG_TTL_MS
    ? Effect.succeed(cache.snapshot)
    : refresh(cache, now).pipe(
        // A slow fetch must not block the turn: time out to whatever stale
        // snapshot exists (empty on first load) while the forked fiber keeps
        // running and populates the cache for the next lookup.
        Effect.flatMap((fiber) =>
          Fiber.join(fiber).pipe(Effect.timeout(LOOKUP_TIMEOUT))
        ),
        Effect.orElseSucceed((): CatalogFacts => cache.snapshot ?? EMPTY_FACTS)
      );

/**
 * A daemon-lifetime cached view of the Gateway catalog's `context_length`
 * by model id. The lookup never fails and never blocks a turn: a catalog
 * fetch error or timeout yields `undefined` (harness defaults apply) and is
 * retried no sooner than {@link FAILURE_RETRY_MS} later.
 */
const makeContextWindowLookup = (): ContextWindowLookupShape => {
  const cache: CatalogCache = {
    pending: undefined,
    snapshot: undefined,
  };
  return {
    lookup: (model) =>
      (model === null || model === undefined
        ? Effect.succeedNone
        : Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => factsEffect(cache, now)),
            Effect.map((facts) =>
              Option.fromNullishOr(facts.windows.get(catalogModelId(model)))
            )
          )
      ).pipe(Effect.map(Option.getOrUndefined)),
    effortFor: (model) =>
      (model === null || model === undefined
        ? Effect.succeedNone
        : Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => factsEffect(cache, now)),
            // An id the catalog never listed is unknown, not incapable: an empty
            // snapshot (fetch failed) and a `~latest` alias both land here.
            Effect.map((facts) => {
              const id = catalogModelId(model);
              if (!facts.known.has(id)) {
                return Option.none();
              }
              // `null` distinguishes "listed, cannot reason" from "never heard
              // of it", which `undefined` alone could not carry.
              return Option.some(facts.efforts.get(id) ?? null);
            })
          )
      ).pipe(Effect.map(Option.getOrUndefined)),
  };
};

/**
 * The catalog view as a service, so its cache belongs to whoever provided the
 * layer. It was a module-level singleton, which meant every consumer in a
 * process shared one cache: a single failed fetch cached an empty snapshot that
 * every later caller then read. Under a virtual clock that snapshot never
 * expired, so one test with no catalog stub silently changed the answers of
 * every test that ran after it.
 */
export class ContextWindowLookup extends Context.Service<
  ContextWindowLookup,
  ContextWindowLookupShape
>()("routekit-eval/runloop/ContextWindowLookup") {
  /** A fresh cache per provision; construction needs no Effects. */
  static readonly layer: Layer.Layer<ContextWindowLookup> = Layer.sync(
    ContextWindowLookup
  )(() => ContextWindowLookup.of(makeContextWindowLookup()));
}

export { makeContextWindowLookup };
export type { ContextWindowLookupShape };
