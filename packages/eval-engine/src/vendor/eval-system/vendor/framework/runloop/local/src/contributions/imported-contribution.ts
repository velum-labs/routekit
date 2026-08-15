import type {
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { BootDiagnostic } from "../feature-boot/diagnostic-types.ts";
import type { ProviderOrigin } from "../../../../utils/core/src/provider-selection-support.ts";

import { formatFeatureLoaderDiagnostic } from "../../../../engine/features/src/feature-loader-diagnostics.ts";
import {
  makeImportBootDiagnostics,
  makeImportBootWarnings,
} from "../feature-boot/diagnostic-record.ts";

// `db` and `model` are internal registry kinds, not author capabilities: the
// state store and the default orchestrator model are host/harness concerns, not
// `feature.ts` contributions. They are unioned in here so their boot records
// typecheck without widening the author-facing `Capability` enum.
type ImportedContributionKind =
  | NonNullable<ResolvedContribution["kind"]>
  | "db"
  | "model";

export interface ImportedContribution<Entry> {
  readonly entry: Entry;
  readonly featureId: string;
  readonly kind: ImportedContributionKind;
  readonly origin: ProviderOrigin;
  readonly shadows: boolean;
  readonly sourcePath: string;
}

/**
 * One kind's worth of contributions moving through the boot pipeline: the
 * entries in registration order, the provenance record behind each, and the
 * diagnostics the stage produced. Every contribution kind uses this one shape
 * at both the import and register stages — a new kind declares its entry type
 * and reuses this instead of adding another structurally identical interface.
 */
export interface ContributionSet<Entry> {
  readonly diagnostics: readonly BootDiagnostic[];
  readonly entries: readonly Entry[];
  readonly records: readonly ImportedContribution<Entry>[];
}

export const formatFeatureDisabledDiagnostics = (
  feature: ResolvedFeature
): readonly string[] =>
  feature.diagnostics.map(
    (diagnostic) =>
      `feature "${feature.id}" disabled: ${formatFeatureLoaderDiagnostic(diagnostic)}`
  );

export const makeContributionSourcePath = (input: {
  readonly contribution: ResolvedContribution;
  readonly feature: ResolvedFeature;
  readonly featuresRoot: string;
  readonly joinPath: (...segments: string[]) => string;
}): string =>
  input.joinPath(input.featuresRoot, input.feature.id, input.contribution.file);

/**
 * The three stage combinators every contribution loader shares. Before this,
 * each of the six per-kind loaders re-declared its own combine/disabled/record
 * plumbing around a bespoke file importer, so adding a kind meant copying the
 * same three functions again (why-map: the eight-kinds-times-ten-files
 * enumeration). A loader now supplies only what is actually per-kind: the
 * file importer, the kind tag, and any bespoke post-processing.
 */
export const combineContributionSets = <Entry>(
  results: readonly ContributionSet<Entry>[]
): ContributionSet<Entry> => ({
  diagnostics: results.flatMap((result) => result.diagnostics),
  entries: results.flatMap((result) => result.entries),
  records: results.flatMap((result) => result.records),
});

/** A disabled feature contributes nothing but its disable diagnostics. */
export const disabledFeatureContributionSet = <Entry>(
  kind: string,
  feature: ResolvedFeature
): ContributionSet<Entry> => ({
  diagnostics: makeImportBootDiagnostics(
    kind,
    formatFeatureDisabledDiagnostics(feature),
    feature.id
  ),
  entries: [],
  records: [],
});

/** Stamp provenance records for freshly imported project entries. */
export const makeProjectContributionSet = <Entry>(input: {
  readonly diagnostics: readonly string[];
  readonly entries: readonly Entry[];
  readonly feature: ResolvedFeature;
  readonly kind: ImportedContribution<Entry>["kind"];
  readonly shadows?: (entry: Entry) => boolean;
  readonly sourcePath: string;
  readonly warnings?: readonly string[];
}): ContributionSet<Entry> => ({
  diagnostics: [
    ...makeImportBootDiagnostics(
      input.kind,
      input.diagnostics,
      input.feature.id
    ),
    ...makeImportBootWarnings(
      input.kind,
      input.warnings ?? [],
      input.feature.id
    ),
  ],
  entries: input.entries,
  records: input.entries.map((entry) => ({
    entry,
    featureId: input.feature.id,
    kind: input.kind,
    origin: "project",
    shadows: input.shadows?.(entry) ?? false,
    sourcePath: input.sourcePath,
  })),
});
