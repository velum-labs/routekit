import { Data } from "effect";

import type { ResolvedFeature } from "./feature-loader-types.ts";

const EMPTY_COUNT = 0;

const TopologicalOrder = Data.taggedEnum<TopologicalOrder>();

type TopologicalOrder = Data.TaggedEnum<{
  Cycle: { readonly featureIds: readonly string[] };
  Ordered: { readonly featureIds: readonly string[] };
}>;

const orderFeatures = (state: {
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ordered: readonly string[];
  readonly remaining: readonly ResolvedFeature[];
  readonly visited: ReadonlySet<string>;
}): TopologicalOrder => {
  if (state.remaining.length === EMPTY_COUNT) {
    return TopologicalOrder.Ordered({ featureIds: state.ordered });
  }

  const next = state.remaining.find((feature) =>
    [...(state.edges.get(feature.id) ?? [])].every((dependencyId) =>
      state.visited.has(dependencyId)
    )
  );
  if (next === undefined) {
    return TopologicalOrder.Cycle({
      featureIds: state.remaining.map((feature) => feature.id),
    });
  }

  return orderFeatures({
    ...state,
    ordered: [...state.ordered, next.id],
    remaining: state.remaining.filter((feature) => feature.id !== next.id),
    visited: new Set([...state.visited, next.id]),
  });
};

export const topologicalOrder = (
  features: readonly ResolvedFeature[],
  edges: ReadonlyMap<string, ReadonlySet<string>>
): TopologicalOrder =>
  orderFeatures({
    edges,
    ordered: [],
    remaining: features,
    visited: new Set(),
  });

export { TopologicalOrder };
