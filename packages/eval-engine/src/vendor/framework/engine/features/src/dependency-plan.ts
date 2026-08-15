import type { FileSystem, Path } from "effect";

import { Effect } from "effect";

import type { FeaturePackageInfo } from "./dependency-types.ts";
import type { ResolvedFeature } from "./feature-loader-types.ts";

import {
  buildDependencyGraph,
  resolveDependencyGraph,
} from "./dependency-graph.ts";
import { readFeaturePackages } from "./package-reader.ts";

interface ResolveFeatureDependencyPlanOptions {
  readonly affectedFeatureIds?: readonly string[] | undefined;
  readonly previousPackageInfos?: readonly FeaturePackageInfo[] | undefined;
}

const orderPackageInfos = (
  infos: readonly FeaturePackageInfo[],
  featureIds: ReadonlySet<string>
): readonly FeaturePackageInfo[] => {
  const order = new Map([...featureIds].map((id, index) => [id, index]));
  return infos
    .filter((info) => featureIds.has(info.featureId))
    .map((info, index) => ({
      index,
      info,
    }))
    .toSorted(
      (left, right) =>
        (order.get(left.info.featureId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.info.featureId) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index
    )
    .map(({ info }) => info);
};

const readReloadAwareFeaturePackages = (
  featuresRoot: string,
  features: readonly ResolvedFeature[],
  options: ResolveFeatureDependencyPlanOptions
): Effect.Effect<
  readonly FeaturePackageInfo[],
  never,
  FileSystem.FileSystem | Path.Path
> => {
  if (
    options.affectedFeatureIds === undefined ||
    options.previousPackageInfos === undefined
  ) {
    return readFeaturePackages(featuresRoot, features);
  }

  const affected = new Set(options.affectedFeatureIds);
  const featureIds = new Set(features.map((feature) => feature.id));
  const previousByFeature = new Map(
    options.previousPackageInfos.map((info) => [info.featureId, info])
  );
  const reusable = features.flatMap((feature) => {
    const previous = previousByFeature.get(feature.id);
    return affected.has(feature.id) || previous === undefined ? [] : previous;
  });
  const changedFeatures = features.filter((feature) =>
    affected.has(feature.id)
  );

  return readFeaturePackages(featuresRoot, changedFeatures).pipe(
    Effect.map((changed) =>
      orderPackageInfos([...reusable, ...changed], featureIds)
    )
  );
};

export const resolveFeatureDependencyPlan = Effect.fn(
  "FeatureDependencyPlan.resolve"
)(function* (
  featuresRoot: string,
  features: readonly ResolvedFeature[],
  options: ResolveFeatureDependencyPlanOptions = {}
) {
  const packageInfos = yield* readReloadAwareFeaturePackages(
    featuresRoot,
    features,
    options
  );
  const graph = buildDependencyGraph(features, packageInfos);
  return resolveDependencyGraph(features, graph);
});

export type { ResolveFeatureDependencyPlanOptions };
