import type { DependencyDiagnostic } from "./dependency-diagnostics.ts";
import type { ResolvedFeature } from "./feature-loader-types.ts";

export interface FeatureDependencyPlan {
  readonly bootOrder: readonly string[];
  readonly dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly enabledFeatures: readonly ResolvedFeature[];
  readonly packageInfos: readonly FeaturePackageInfo[];
}

export interface FeaturePackageInfo {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly featureId: string;
  readonly name?: string;
}

export const emptyPackageInfo = (featureId: string): FeaturePackageInfo => ({
  dependencies: {},
  diagnostics: [],
  featureId,
});
