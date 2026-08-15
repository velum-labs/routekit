import type { ImportedContribution } from "../contributions/imported-contribution.ts";
import type { BootDiagnostic } from "./diagnostic-types.ts";

import { makeBuiltInShadowDiagnostic } from "./diagnostic-record.ts";

// Built-in feature ids are namespaced (`@routekit-eval-builtins/chat-tui`), but a project
// feature id is a bare `features/` directory name, so the two are compared on
// the built-in's name rather than its full id (RFC 0003
// runtime-events-and-failure-policy.md, built-in feature shadowing).
const BUILT_IN_FEATURE_NAMESPACE = "@routekit-eval-builtins/";

export const builtInFeatureName = (featureId: string): string =>
  featureId.startsWith(BUILT_IN_FEATURE_NAMESPACE)
    ? featureId.slice(BUILT_IN_FEATURE_NAMESPACE.length)
    : featureId;

export interface ShadowedBuiltInFeature {
  readonly builtInFeatureId: string;
  /** Contribution kinds the built-in registered, all of which are dropped. */
  readonly kinds: readonly string[];
  readonly projectFeatureId: string;
}

export interface BuiltInShadowPlan {
  readonly diagnostics: readonly BootDiagnostic[];
  readonly isShadowed: (record: { readonly featureId: string }) => boolean;
  readonly shadowed: readonly ShadowedBuiltInFeature[];
}

interface BuiltInFeatureRecord {
  readonly featureId: string;
  readonly kinds: Set<string>;
}

const indexBuiltInsByName = (
  records: readonly ImportedContribution<unknown>[]
): Map<string, BuiltInFeatureRecord[]> => {
  const byName = new Map<string, BuiltInFeatureRecord[]>();
  for (const record of records) {
    const name = builtInFeatureName(record.featureId);
    const features = byName.get(name) ?? [];
    const existing = features.find(
      (feature) => feature.featureId === record.featureId
    );
    if (existing === undefined) {
      features.push({
        featureId: record.featureId,
        kinds: new Set([record.kind]),
      });
      byName.set(name, features);
      continue;
    }
    existing.kinds.add(record.kind);
  }
  return byName;
};

/**
 * Plan built-in feature shadowing for one boot (RFC 0003
 * runtime-events-and-failure-policy.md). An enabled project feature whose name
 * matches a built-in feature's name replaces that built-in wholesale: every
 * contribution the built-in registered is dropped before per-kind registration,
 * including kinds the project feature does not contribute itself. Matching never
 * looks at contribution or export names, so this is a feature-level decision
 * that runs ahead of the per-kind name-collision rule.
 *
 * `projectFeatureIds` must be the *enabled* features only. A feature disabled by
 * an invalid manifest, a failed import, or a missing dependency must not remove
 * a built-in, or a typo would silently delete framework capability.
 */
export const planBuiltInShadowing = (input: {
  readonly builtInRecords: readonly ImportedContribution<unknown>[];
  readonly projectFeatureIds: readonly string[];
}): BuiltInShadowPlan => {
  const byName = indexBuiltInsByName(input.builtInRecords);
  const shadowed: ShadowedBuiltInFeature[] = [];
  const shadowedFeatureIds = new Set<string>();

  for (const projectFeatureId of input.projectFeatureIds) {
    const features = byName.get(builtInFeatureName(projectFeatureId));
    if (features === undefined) {
      continue;
    }
    for (const feature of features) {
      if (shadowedFeatureIds.has(feature.featureId)) {
        continue;
      }
      shadowedFeatureIds.add(feature.featureId);
      shadowed.push({
        builtInFeatureId: feature.featureId,
        kinds: [...feature.kinds].toSorted(),
        projectFeatureId,
      });
    }
  }

  return {
    diagnostics: shadowed.map((feature) =>
      makeBuiltInShadowDiagnostic({
        builtInFeatureId: feature.builtInFeatureId,
        kinds: feature.kinds,
        projectFeatureId: feature.projectFeatureId,
      })
    ),
    isShadowed: (record) => shadowedFeatureIds.has(record.featureId),
    shadowed,
  };
};

/** A boot where nothing shadowed anything, for callers assembling a result by hand. */
export const emptyBuiltInShadowPlan: BuiltInShadowPlan = {
  diagnostics: [],
  isShadowed: () => false,
  shadowed: [],
};
