import { Data, Function as F } from "effect";

export class InvalidPackageJsonDiagnostic extends Data.TaggedClass(
  "InvalidPackageJsonDiagnostic"
)<{
  readonly featureId: string;
}> {}

export class DuplicatePackageNameDiagnostic extends Data.TaggedClass(
  "DuplicatePackageNameDiagnostic"
)<{
  readonly packageName: string;
  readonly featureIds: readonly string[];
}> {}

export class MissingDependencyDiagnostic extends Data.TaggedClass(
  "MissingDependencyDiagnostic"
)<{
  readonly featureId: string;
  readonly dependencyName: string;
}> {}

export class DisabledDependencyDiagnostic extends Data.TaggedClass(
  "DisabledDependencyDiagnostic"
)<{
  readonly featureId: string;
  readonly dependencyName: string;
}> {}

export class CycleDiagnostic extends Data.TaggedClass("CycleDiagnostic")<{
  readonly featureIds: readonly string[];
}> {}

export class DisabledByDependencyDiagnostic extends Data.TaggedClass(
  "DisabledByDependencyDiagnostic"
)<{
  readonly featureId: string;
  readonly dependencyId: string;
}> {}

export type DependencyDiagnostic =
  | CycleDiagnostic
  | DisabledByDependencyDiagnostic
  | DisabledDependencyDiagnostic
  | DuplicatePackageNameDiagnostic
  | InvalidPackageJsonDiagnostic
  | MissingDependencyDiagnostic;

export const formatDependencyDiagnostic = (
  diagnostic: DependencyDiagnostic
): string => {
  switch (diagnostic._tag) {
    case "InvalidPackageJsonDiagnostic": {
      return `feature "${diagnostic.featureId}" disabled: invalid package.json`;
    }
    case "DuplicatePackageNameDiagnostic": {
      return `feature package name "${diagnostic.packageName}" is duplicated by features "${diagnostic.featureIds.join('", "')}"`;
    }
    case "MissingDependencyDiagnostic": {
      return `feature "${diagnostic.featureId}" disabled: dependency "${diagnostic.dependencyName}" is missing`;
    }
    case "DisabledDependencyDiagnostic": {
      return `feature "${diagnostic.featureId}" disabled: dependency "${diagnostic.dependencyName}" is disabled`;
    }
    case "CycleDiagnostic": {
      return `feature dependency cycle: ${diagnostic.featureIds.join(" -> ")}`;
    }
    case "DisabledByDependencyDiagnostic": {
      return `feature "${diagnostic.featureId}" disabled: dependency feature "${diagnostic.dependencyId}" is disabled`;
    }
    default: {
      return F.absurd(diagnostic);
    }
  }
};
