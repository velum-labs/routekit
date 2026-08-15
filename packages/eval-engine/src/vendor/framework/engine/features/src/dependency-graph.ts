import type { DependencyDiagnostic } from "./dependency-diagnostics.ts";
import type {
  FeatureDependencyPlan,
  FeaturePackageInfo,
} from "./dependency-types.ts";
import type { ResolvedFeature } from "./feature-loader-types.ts";

import {
  CycleDiagnostic,
  DisabledDependencyDiagnostic,
  DuplicatePackageNameDiagnostic,
  MissingDependencyDiagnostic,
} from "./dependency-diagnostics.ts";
import { propagateDisabledDependencies } from "./dependency-disabled.ts";
import {
  TopologicalOrder,
  topologicalOrder,
} from "./dependency-order.ts";
import { emptyPackageInfo } from "./dependency-types.ts";

const WORKSPACE_PROTOCOL = "workspace:";
const EMPTY_COUNT = 0;

interface DependencyGraph {
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly disabled: ReadonlySet<string>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly packageInfos: readonly FeaturePackageInfo[];
}

interface DependencyIndexes {
  readonly featureById: ReadonlyMap<string, ResolvedFeature>;
  readonly featureByPackageName: ReadonlyMap<string, FeaturePackageInfo>;
  readonly packageByFeature: ReadonlyMap<string, FeaturePackageInfo>;
}

interface DependencyEdge {
  readonly dependencyId: string;
  readonly featureId: string;
}

interface DependencyEdgeSet {
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly disabledFeatureIds: ReadonlySet<string>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}

interface PackageNameIndex {
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly disabledFeatureIds: ReadonlySet<string>;
  readonly featureByPackageName: ReadonlyMap<string, FeaturePackageInfo>;
}

const indexFeaturesById = (
  features: readonly ResolvedFeature[]
): ReadonlyMap<string, ResolvedFeature> =>
  new Map(features.map((feature) => [feature.id, feature]));

const makeDependencyIndexes = (input: {
  readonly featureByPackageName: ReadonlyMap<string, FeaturePackageInfo>;
  readonly features: readonly ResolvedFeature[];
  readonly packageInfos: readonly FeaturePackageInfo[];
}): DependencyIndexes => ({
  featureById: indexFeaturesById(input.features),
  featureByPackageName: input.featureByPackageName,
  packageByFeature: new Map(
    input.packageInfos.map((info) => [info.featureId, info])
  ),
});

const isFeatureEnabled = (
  feature: ResolvedFeature,
  disabled: ReadonlySet<string>
): boolean => feature.valid && !disabled.has(feature.id);

const indexFeaturePackageNames = (
  packageInfos: readonly FeaturePackageInfo[]
): PackageNameIndex => {
  const featuresByPackageName = new Map<string, FeaturePackageInfo[]>();
  for (const info of packageInfos) {
    if (info.name === undefined) {
      continue;
    }
    featuresByPackageName.set(info.name, [
      ...(featuresByPackageName.get(info.name) ?? []),
      info,
    ]);
  }

  const diagnostics: DependencyDiagnostic[] = [];
  const disabledFeatureIds = new Set<string>();
  const featureByPackageName = new Map<string, FeaturePackageInfo>();
  for (const [name, infos] of featuresByPackageName) {
    if (infos.length === 1) {
      featureByPackageName.set(name, infos[0]);
      continue;
    }
    const featureIds = infos.map((info) => info.featureId);
    diagnostics.push(
      new DuplicatePackageNameDiagnostic({
        featureIds,
        packageName: name,
      })
    );
    for (const featureId of featureIds) {
      disabledFeatureIds.add(featureId);
    }
  }

  return {
    diagnostics,
    disabledFeatureIds,
    featureByPackageName,
  };
};

const addDependencyIds = (
  target: Map<string, ReadonlySet<string>>,
  featureId: string,
  dependencyIds: Iterable<string>
): void => {
  target.set(
    featureId,
    new Set([...(target.get(featureId) ?? []), ...dependencyIds])
  );
};

const mergeDependencyEdgeMaps = (
  edgeMaps: readonly ReadonlyMap<string, ReadonlySet<string>>[]
): ReadonlyMap<string, ReadonlySet<string>> => {
  const merged = new Map<string, ReadonlySet<string>>();
  for (const edgeMap of edgeMaps) {
    for (const [featureId, dependencyIds] of edgeMap) {
      addDependencyIds(merged, featureId, dependencyIds);
    }
  }
  return merged;
};

const combineDependencyEdgeSets = (
  edgeSets: readonly DependencyEdgeSet[]
): DependencyEdgeSet => ({
  diagnostics: edgeSets.flatMap((edgeSet) => edgeSet.diagnostics),
  disabledFeatureIds: new Set(
    edgeSets.flatMap((edgeSet) => [...edgeSet.disabledFeatureIds])
  ),
  edges: mergeDependencyEdgeMaps(edgeSets.map((edgeSet) => edgeSet.edges)),
});

const toDependencyEdgeMap = (
  edges: readonly DependencyEdge[]
): ReadonlyMap<string, ReadonlySet<string>> => {
  const mapped = new Map<string, ReadonlySet<string>>();
  for (const edge of edges) {
    addDependencyIds(mapped, edge.featureId, [edge.dependencyId]);
  }
  return mapped;
};

const makeDependencyEdgeSet = (input: {
  readonly diagnostics?: readonly DependencyDiagnostic[];
  readonly disabledFeatureIds?: readonly string[];
  readonly edges?: readonly DependencyEdge[];
}): DependencyEdgeSet => ({
  diagnostics: input.diagnostics ?? [],
  disabledFeatureIds: new Set(input.disabledFeatureIds),
  edges:
    input.edges === undefined ? new Map() : toDependencyEdgeMap(input.edges),
});

const emptyDependencyEdgeSet = (): DependencyEdgeSet =>
  makeDependencyEdgeSet({});

const filterEnabledDependencies = (
  dependencies: ReadonlySet<string> | undefined,
  enabledIds: ReadonlySet<string>
): ReadonlySet<string> =>
  new Set(
    [...(dependencies ?? [])].filter((dependencyId) =>
      enabledIds.has(dependencyId)
    )
  );

const resolveDependencyGraph = (
  features: readonly ResolvedFeature[],
  graph: DependencyGraph
): FeatureDependencyPlan => {
  const enabledFeatures = features.filter((feature) =>
    isFeatureEnabled(feature, graph.disabled)
  );
  const ordered = topologicalOrder(enabledFeatures, graph.edges);

  return TopologicalOrder.$match(ordered, {
    Cycle: (cycle) =>
      ({
        bootOrder: [],
        dependenciesByFeature: new Map(),
        diagnostics: [
          ...graph.diagnostics,
          new CycleDiagnostic({ featureIds: cycle.featureIds }),
        ],
        enabledFeatures: [],
        packageInfos: graph.packageInfos,
      }) satisfies FeatureDependencyPlan,
    Ordered: (order) => {
      const byId = indexFeaturesById(enabledFeatures);
      const enabledIds = new Set(order.featureIds);
      return {
        bootOrder: order.featureIds,
        dependenciesByFeature: new Map(
          order.featureIds.map((featureId) => [
            featureId,
            filterEnabledDependencies(graph.edges.get(featureId), enabledIds),
          ])
        ),
        diagnostics: graph.diagnostics,
        enabledFeatures: order.featureIds.flatMap((featureId) => {
          const feature = byId.get(featureId);
          return feature ? [feature] : [];
        }),
        packageInfos: graph.packageInfos,
      } satisfies FeatureDependencyPlan;
    },
  });
};

const resolveFeatureDependencyPackage = (
  dependencyName: string,
  featureByPackageName: ReadonlyMap<string, FeaturePackageInfo>
): FeaturePackageInfo | undefined => featureByPackageName.get(dependencyName);

const resolveFeatureDependency = (input: {
  readonly dependencyName: string;
  readonly feature: ResolvedFeature;
  readonly indexes: DependencyIndexes;
  readonly version: string;
}): DependencyEdgeSet => {
  if (!input.version.startsWith(WORKSPACE_PROTOCOL)) {
    return emptyDependencyEdgeSet();
  }
  const resolved = resolveFeatureDependencyPackage(
    input.dependencyName,
    input.indexes.featureByPackageName
  );
  if (resolved === undefined) {
    return makeDependencyEdgeSet({
      diagnostics: [
        new MissingDependencyDiagnostic({
          dependencyName: input.dependencyName,
          featureId: input.feature.id,
        }),
      ],
      disabledFeatureIds: [input.feature.id],
    });
  }
  if (input.indexes.featureById.get(resolved.featureId)?.valid !== true) {
    return makeDependencyEdgeSet({
      diagnostics: [
        new DisabledDependencyDiagnostic({
          dependencyName: input.dependencyName,
          featureId: input.feature.id,
        }),
      ],
      disabledFeatureIds: [input.feature.id],
    });
  }
  return makeDependencyEdgeSet({
    edges: [
      {
        dependencyId: resolved.featureId,
        featureId: input.feature.id,
      },
    ],
  });
};

const resolveFeatureDependencies = (
  input: {
    readonly disabled: ReadonlySet<string>;
    readonly indexes: DependencyIndexes;
  },
  feature: ResolvedFeature
): DependencyEdgeSet => {
  if (!isFeatureEnabled(feature, input.disabled)) {
    return emptyDependencyEdgeSet();
  }

  const info =
    input.indexes.packageByFeature.get(feature.id) ??
    emptyPackageInfo(feature.id);
  return combineDependencyEdgeSets(
    Object.entries(info.dependencies).map(([dependencyName, version]) =>
      resolveFeatureDependency({
        dependencyName,
        feature,
        indexes: input.indexes,
        version,
      })
    )
  );
};

const resolveDependencyEdges = (input: {
  readonly disabled: ReadonlySet<string>;
  readonly features: readonly ResolvedFeature[];
  readonly indexes: DependencyIndexes;
}): DependencyEdgeSet =>
  combineDependencyEdgeSets(
    input.features.map((feature) => resolveFeatureDependencies(input, feature))
  );

export const buildDependencyGraph = (
  features: readonly ResolvedFeature[],
  packageInfos: readonly FeaturePackageInfo[]
): DependencyGraph => {
  const packageNameIndex = indexFeaturePackageNames(packageInfos);
  const indexes = makeDependencyIndexes({
    featureByPackageName: packageNameIndex.featureByPackageName,
    features,
    packageInfos,
  });
  const initiallyDisabled = new Set([
    ...packageInfos
      .filter((info) => info.diagnostics.length > EMPTY_COUNT)
      .map((info) => info.featureId),
    ...packageNameIndex.disabledFeatureIds,
  ]);
  const dependencyEdges = resolveDependencyEdges({
    disabled: initiallyDisabled,
    features,
    indexes,
  });
  const propagation = propagateDisabledDependencies({
    diagnostics: [
      ...packageInfos.flatMap((info) => info.diagnostics),
      ...packageNameIndex.diagnostics,
      ...dependencyEdges.diagnostics,
    ],
    disabled: new Set([
      ...initiallyDisabled,
      ...dependencyEdges.disabledFeatureIds,
    ]),
    edges: dependencyEdges.edges,
    features,
  });

  return {
    diagnostics: propagation.diagnostics,
    disabled: propagation.disabled,
    edges: dependencyEdges.edges,
    packageInfos,
  };
};

export { resolveDependencyGraph };
export type { DependencyGraph };
