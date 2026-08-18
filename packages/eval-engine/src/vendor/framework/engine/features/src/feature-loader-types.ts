import type {
  Capability,
  FEATURE_MODULE_FILE,
  FeatureModuleExportName,
} from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import type {
  FeatureLoaderDiagnostic,
  FeatureLoaderWarning,
} from "./feature-loader-diagnostics.ts";

/** A feature module's namespace object, as `import()` returns it. */
export type FeatureModuleNamespace = Readonly<Record<string, unknown>>;

/** One contribution a feature module resolves to (RFC 0002). */
export interface ResolvedContribution {
  readonly entryKey: string;
  readonly exportName?: FeatureModuleExportName | undefined;
  readonly file: string;
  readonly kind?: Capability | undefined;
  readonly moduleNamespace?: FeatureModuleNamespace | undefined;
}

export type DeferredFeatureModuleExportName = "db" | "generation";

/** A feature-module export the loader recognizes but defers (RFC 0002). */
export interface DeferredFeatureModuleContribution {
  readonly entryKey: DeferredFeatureModuleExportName;
  readonly exportName: DeferredFeatureModuleExportName;
  readonly file: typeof FEATURE_MODULE_FILE;
  readonly reason: string;
}

/**
 * One discovered feature, as `discoverFeatures` resolves it. Lives in its own
 * leaf module so the many consumers that only need the shape (dependency
 * planning, catalogs, CLI surfaces) depend on this file rather than the loader
 * itself.
 */
export interface ResolvedFeature {
  readonly contributions: readonly ResolvedContribution[];
  readonly deferredContributions?: readonly DeferredFeatureModuleContribution[];
  readonly diagnostics: readonly FeatureLoaderDiagnostic[];
  readonly hollow: boolean;
  readonly id: string;
  readonly valid: boolean;
  readonly warnings?: readonly FeatureLoaderWarning[];
}

export interface DiscoverFeaturesOptions {
  readonly affectedFeatureIds?: readonly string[] | undefined;
  readonly previousFeatures?: readonly ResolvedFeature[] | undefined;
}

export interface DiscoveredFeatures {
  readonly features: readonly ResolvedFeature[];
  readonly warnings: readonly FeatureLoaderWarning[];
}
