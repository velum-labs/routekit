import { Data, Function as F } from "effect";

import { FEATURE_MODULE_FILE } from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";

const FEATURE_MANIFEST_FILE = "feature.json";

export class InvalidFeatureManifestDiagnostic extends Data.TaggedClass(
  "InvalidFeatureManifestDiagnostic"
)<{
  readonly featureId: string;
  readonly detail: string;
}> {}

export class InvalidFeatureModuleDiagnostic extends Data.TaggedClass(
  "InvalidFeatureModuleDiagnostic"
)<{
  readonly featureId: string;
  readonly detail: string;
}> {}

export class DefaultExportFeatureModuleDiagnostic extends Data.TaggedClass(
  "DefaultExportFeatureModuleDiagnostic"
)<{
  readonly featureId: string;
}> {}

export class FeaturePathEscapeDiagnostic extends Data.TaggedClass(
  "FeaturePathEscapeDiagnostic"
)<{
  readonly featureId: string;
  readonly candidate: string;
}> {}

export type FeatureLoaderDiagnostic =
  | DefaultExportFeatureModuleDiagnostic
  | FeaturePathEscapeDiagnostic
  | InvalidFeatureManifestDiagnostic
  | InvalidFeatureModuleDiagnostic;

/**
 * Non-fatal loader warnings. Unlike {@link FeatureLoaderDiagnostic}, these never
 * disable a feature or drop its other valid contributions — they surface authoring
 * mistakes loudly without breaking the boot. Kept as a type distinct from the fatal
 * `diagnostics` stream so a warning can never accidentally flip `feature.valid`.
 */

export class UnrecognizedFeatureModuleExportDiagnostic extends Data.TaggedClass(
  "UnrecognizedFeatureModuleExportDiagnostic"
)<{
  readonly featureId: string;
  readonly exportName: string;
  readonly suggestion?: string | undefined;
}> {}

export class HollowFeatureDiagnostic extends Data.TaggedClass(
  "HollowFeatureDiagnostic"
)<{
  readonly featureId: string;
}> {}

export class InvalidFeatureDirectoryWarning extends Data.TaggedClass(
  "InvalidFeatureDirectoryWarning"
)<{
  readonly directoryName: string;
}> {}

export class UnrecognizedSkillPathWarning extends Data.TaggedClass(
  "UnrecognizedSkillPathWarning"
)<{
  readonly filePath: string;
}> {}

export class ReservedRootSkillsFileWarning extends Data.TaggedClass(
  "ReservedRootSkillsFileWarning"
)<{
  readonly fileName: string;
}> {}

export type FeatureLoaderWarning =
  | HollowFeatureDiagnostic
  | InvalidFeatureDirectoryWarning
  | ReservedRootSkillsFileWarning
  | UnrecognizedSkillPathWarning
  | UnrecognizedFeatureModuleExportDiagnostic;

export const formatFeatureLoaderDiagnostic = (
  diagnostic: FeatureLoaderDiagnostic
): string => {
  switch (diagnostic._tag) {
    case "InvalidFeatureManifestDiagnostic": {
      return `invalid ${FEATURE_MANIFEST_FILE} for feature "${diagnostic.featureId}": ${diagnostic.detail}`;
    }
    case "InvalidFeatureModuleDiagnostic": {
      return `invalid ${FEATURE_MODULE_FILE} for feature "${diagnostic.featureId}": ${diagnostic.detail}`;
    }
    case "DefaultExportFeatureModuleDiagnostic": {
      return `${FEATURE_MODULE_FILE} for feature "${diagnostic.featureId}" uses a default-exported FeatureModule object, which is no longer recognized; use named exports instead (e.g. \`export const harness = ...\`)`;
    }
    case "FeaturePathEscapeDiagnostic": {
      return `contribution path "${diagnostic.candidate}" escapes the feature directory`;
    }
    default: {
      return F.absurd(diagnostic);
    }
  }
};

export const formatFeatureLoaderWarning = (
  warning: FeatureLoaderWarning
): string => {
  switch (warning._tag) {
    case "UnrecognizedFeatureModuleExportDiagnostic": {
      const base = `feature "${warning.featureId}" ${FEATURE_MODULE_FILE} export "${warning.exportName}" is not a recognized contribution and was ignored`;
      return warning.suggestion === undefined
        ? base
        : `${base}; did you mean "${warning.suggestion}"?`;
    }
    case "HollowFeatureDiagnostic": {
      return `feature "${warning.featureId}" is hollow: it resolves no contributions (no recognized ${FEATURE_MODULE_FILE} exports, no prompt.md, and no SKILL.md)`;
    }
    case "InvalidFeatureDirectoryWarning": {
      return `feature directory "${warning.directoryName}" is not a valid feature id (lowercase letters, digits, and dashes, starting with a letter or digit); rename the directory`;
    }
    case "UnrecognizedSkillPathWarning": {
      return `SKILL.md at "${warning.filePath}" is not in a recognized skill layout; use "<feature-id>/SKILL.md", "<feature-id>/skills/<name>/SKILL.md", or "skills/<name>/SKILL.md" under the features root`;
    }
    case "ReservedRootSkillsFileWarning": {
      return `file "skills/${warning.fileName}" was ignored because "skills" is reserved for standalone skills; rename the directory if you intended to author a feature`;
    }
    default: {
      return F.absurd(warning);
    }
  }
};
