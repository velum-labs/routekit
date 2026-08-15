import type { Effect as EffectType } from "effect";

import { Context, Effect } from "effect";

import type {
  ApiContribution,
  ApiExports,
  ApiFeatureContext as FeatureContext,
  ApiRegistryEntry,
} from "../../../contracts/internal/src/author-schemas/api.ts";

import { RegistryError } from "../../../contracts/internal/src/errors.ts";

/** A provider that declared no `exports` still resolves `use()` to an empty bag. */
const EMPTY_EXPORTS: ApiExports = {};

type ApiRegistryRunEffect = <Value, Error>(
  effect: EffectType.Effect<Value, Error>
) => Promise<Value>;

interface ApiRegistryShape {
  readonly contextFor: (featureId: string) => FeatureContext;
  readonly entries: readonly ApiRegistryEntry[];
  readonly get: (
    featureId: string
  ) => EffectType.Effect<ApiContribution, RegistryError>;
}

class ApiRegistry extends Context.Service<ApiRegistry, ApiRegistryShape>()(
  "routekit-eval/runtime/ApiRegistry"
) {}

const getApiByFeatureId = (
  byFeatureId: ReadonlyMap<string, ApiContribution>,
  featureId: string
): Effect.Effect<ApiContribution, RegistryError> => {
  const api = byFeatureId.get(featureId);
  if (api === undefined) {
    return new RegistryError({
      kind: "api",
      name: featureId,
    });
  }
  return Effect.succeed(api);
};

const makeFeatureContext = (input: {
  readonly get: (
    featureId: string
  ) => Effect.Effect<ApiContribution, RegistryError>;
  readonly runEffect: ApiRegistryRunEffect;
}): FeatureContext => {
  // `use(providerId)` resolves to the provider's `exports` bag only — never its
  // `routes` — and defaults to `{}` when the provider declared no `exports`
  // (RFC 0002 api.md). Any feature may `use()` any other registered feature;
  // the only requirement is the standard `routekit-eval` SDK dependency, not a per-pair
  // `package.json` edge.
  const use = (featureId: string): Promise<ApiExports> =>
    input.runEffect(
      Effect.gen(function* () {
        const contribution = yield* input.get(featureId);
        return contribution.exports ?? EMPTY_EXPORTS;
      })
    );
  // The author contract types `use` through the `FeatureApis` declaration-merge
  // registry (RFC 0002 api.md, "Typed `use()`"). Registrations are declared,
  // not verified, so the runtime provides one untyped resolver and declares it
  // as the overloaded handle here — the single sanctioned cast.
  // oxlint-disable-next-line no-unsafe-type-assertion -- declared-not-verified by contract
  return { use: use as FeatureContext["use"] };
};

export const makeApiRegistry = (
  entries: readonly ApiRegistryEntry[],
  runEffect: ApiRegistryRunEffect
): ApiRegistryShape => {
  const byFeatureId = new Map(
    entries.map((entry) => [entry.featureId, entry.api])
  );

  const get = (
    featureId: string
  ): Effect.Effect<ApiContribution, RegistryError> =>
    getApiByFeatureId(byFeatureId, featureId);

  // The context no longer varies per caller (there is no per-pair dependency
  // gate to check), so every `contextFor` call shares one context.
  const context = makeFeatureContext({
    get,
    runEffect,
  });

  return ApiRegistry.of({
    contextFor: () => context,
    entries,
    get,
  });
};

export { ApiRegistry };
export type { ApiRegistryRunEffect, ApiRegistryShape };
export type { FeatureContext };
