import { Function as F } from "effect";

import type { DependencyDiagnostic } from "../../../../engine/features/src/dependency-diagnostics.ts";
import type { FeatureLoaderWarning } from "../../../../engine/features/src/feature-loader-diagnostics.ts";
import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { ImportedContribution } from "../contributions/imported-contribution.ts";
import type { BuiltInShadowPlan } from "./built-in-shadow.ts";
import type {
  ImportedFeatureContributions,
  RegisteredFeatureContributions,
} from "./contributions.ts";
import type { BootDiagnostic } from "./diagnostic-types.ts";
import type { FeatureBootOptions } from "./options.ts";

import { formatDependencyDiagnostic } from "../../../../engine/features/src/dependency-diagnostics.ts";
import {
  formatFeatureLoaderDiagnostic,
  formatFeatureLoaderWarning,
} from "../../../../engine/features/src/feature-loader-diagnostics.ts";
import { makeContributionBootDiagnostic } from "./diagnostic-record.ts";

const EMPTY_COUNT = 0;

const formatBootDiagnostic = (diagnostic: BootDiagnostic): string =>
  `${diagnostic.code}: ${diagnostic.message}`;

const formatBootDiagnosticMessages = (
  diagnostics: readonly BootDiagnostic[],
  level: BootDiagnostic["level"]
): readonly string[] =>
  diagnostics
    .filter((diagnostic) => diagnostic.level === level)
    .map((diagnostic) => diagnostic.message);

const makeBootDiagnostics = (input: {
  readonly diagnosticRecords: readonly BootDiagnostic[];
}): readonly string[] =>
  formatBootDiagnosticMessages(input.diagnosticRecords, "error");

const makeBootWarnings = (input: {
  readonly diagnosticRecords: readonly BootDiagnostic[];
}): readonly string[] =>
  formatBootDiagnosticMessages(input.diagnosticRecords, "warning");

// A default-exported FeatureModule (formerly ROUTEKIT_EVAL-167) gets the sniffer-case
// `ROUTEKIT_EVAL_BOOT_IMPORT_FEATURE_MODULE` code instead of the generic
// `ROUTEKIT_EVAL_BOOT_FEATURE_DISABLED`, so the migration report (RFC 0002
// compatibility-and-migration.md) can correlate it with the
// `feature-module-named-exports-required` shape-change rule the same way it
// already does for `ROUTEKIT_EVAL_BOOT_IMPORT_SCHEDULE`/`ROUTEKIT_EVAL_BOOT_IMPORT_API`.
const disabledFeatureDiagnosticCode = (
  diagnostic: ResolvedFeature["diagnostics"][number]
): string =>
  diagnostic._tag === "DefaultExportFeatureModuleDiagnostic"
    ? "ROUTEKIT_EVAL_BOOT_IMPORT_FEATURE_MODULE"
    : "ROUTEKIT_EVAL_BOOT_FEATURE_DISABLED";

const makeDisabledFeatureDiagnostics = (
  features: readonly ResolvedFeature[]
): readonly BootDiagnostic[] =>
  features.flatMap((feature) =>
    feature.valid
      ? []
      : feature.diagnostics.map(
          (diagnostic): BootDiagnostic => ({
            code: disabledFeatureDiagnosticCode(diagnostic),
            featureId: feature.id,
            level: "error",
            message: `feature "${feature.id}" disabled: ${formatFeatureLoaderDiagnostic(diagnostic)}`,
          })
        )
  );

const FEATURE_WARNING_CODE = {
  HollowFeatureDiagnostic: "ROUTEKIT_EVAL_BOOT_FEATURE_HOLLOW",
  InvalidFeatureDirectoryWarning: "ROUTEKIT_EVAL_BOOT_FEATURE_ID_INVALID",
  ReservedRootSkillsFileWarning: "ROUTEKIT_EVAL_BOOT_FEATURE_SKILLS_RESERVED",
  UnrecognizedSkillPathWarning: "ROUTEKIT_EVAL_BOOT_FEATURE_SKILL_PATH_UNRECOGNIZED",
  UnrecognizedFeatureModuleExportDiagnostic:
    "ROUTEKIT_EVAL_BOOT_FEATURE_EXPORT_UNRECOGNIZED",
} as const;

const makeFeatureWarningDiagnostics = (
  features: readonly ResolvedFeature[]
): readonly BootDiagnostic[] =>
  features.flatMap((feature) =>
    (feature.warnings ?? []).map(
      (warning): BootDiagnostic => ({
        code: FEATURE_WARNING_CODE[warning._tag],
        featureId: feature.id,
        level: "warning",
        message: formatFeatureLoaderWarning(warning),
      })
    )
  );

const makeRootFeatureWarningDiagnostics = (
  warnings: readonly FeatureLoaderWarning[]
): readonly BootDiagnostic[] =>
  warnings.map((warning) => ({
    code: FEATURE_WARNING_CODE[warning._tag],
    level: "warning",
    message: formatFeatureLoaderWarning(warning),
  }));

const makeDiscoveredOnlyContributionDiagnostics = (
  features: readonly ResolvedFeature[]
): readonly BootDiagnostic[] =>
  features.flatMap((feature) =>
    (feature.deferredContributions ?? []).map((contribution) =>
      makeContributionBootDiagnostic({
        code: "ROUTEKIT_EVAL_BOOT_CONTRIBUTION_DISCOVERED_ONLY",
        contributionName: contribution.entryKey,
        entryKey: contribution.entryKey,
        featureId: feature.id,
        level: "warning",
        message: `feature "${feature.id}" export "${contribution.exportName}" is discovered but not registered: ${contribution.reason}`,
      })
    )
  );

const extractFeatureIdFromDependencyDiagnostic = (
  diagnostic: DependencyDiagnostic
): { readonly featureId: string } | undefined => {
  switch (diagnostic._tag) {
    case "CycleDiagnostic":
    case "DuplicatePackageNameDiagnostic": {
      return undefined;
    }
    case "DisabledByDependencyDiagnostic":
    case "DisabledDependencyDiagnostic":
    case "InvalidPackageJsonDiagnostic":
    case "MissingDependencyDiagnostic": {
      return { featureId: diagnostic.featureId };
    }
    default: {
      return F.absurd(diagnostic);
    }
  }
};

// A cycle gets its own code because the two failures have opposite severities.
// RFC 0003 failure policy item 6 makes a dependency cycle a fatal boot error,
// while a missing dependency only disables the dependent and its transitive
// dependents. `resolveDependencyGraph` returns an empty `bootOrder` and an empty
// `enabledFeatures` for a cycle, so degrading it would boot built-ins only: a
// technically runnable but useless runtime reported as a single warning.
const dependencyDiagnosticCode = (diagnostic: DependencyDiagnostic): string =>
  diagnostic._tag === "CycleDiagnostic"
    ? "ROUTEKIT_EVAL_BOOT_DEPENDENCY_CYCLE"
    : "ROUTEKIT_EVAL_BOOT_DEPENDENCY_INVALID";

const makeDependencyDiagnosticRecords = (
  diagnostics: readonly DependencyDiagnostic[]
): readonly BootDiagnostic[] =>
  diagnostics.map((diagnostic): BootDiagnostic => {
    const message = formatDependencyDiagnostic(diagnostic);
    return {
      code: dependencyDiagnosticCode(diagnostic),
      ...extractFeatureIdFromDependencyDiagnostic(diagnostic),
      level: "error",
      message,
    };
  });

const getProjectHarnessRecords = (
  records: RegisteredFeatureContributions["harnesses"]["records"]
): ImportedContribution<RuntimeHarness>[] =>
  records.filter((record) => record.origin === "project");

/**
 * An empty required registry reads as a framework bug unless the boot says who
 * emptied it. A feature that shadowed a built-in harness and then contributed
 * none is the one cause the runtime can name, so it is spelled out here rather
 * than left for the author to reverse-engineer (RFC 0003
 * runtime-events-and-failure-policy.md, built-in feature shadowing).
 */
const formatShadowCause = (
  builtInShadow: BuiltInShadowPlan,
  kind: string
): string => {
  const causes = builtInShadow.shadowed.filter((feature) =>
    feature.kinds.includes(kind)
  );
  if (causes.length === EMPTY_COUNT) {
    return "";
  }
  const named = causes
    .map(
      (feature) =>
        `feature "${feature.projectFeatureId}" shadows built-in feature "${feature.builtInFeatureId}"`
    )
    .join(", ");
  return `: ${named} and contributes no ${kind}`;
};

const formatHarnessRegistryDiagnostics = (input: {
  readonly builtInDefaultHarnessName?: RuntimeHarness["name"] | undefined;
  readonly builtInShadow: BuiltInShadowPlan;
  readonly records: RegisteredFeatureContributions["harnesses"]["records"];
}): readonly BootDiagnostic[] => {
  if (input.records.length === EMPTY_COUNT) {
    return [
      {
        code: "ROUTEKIT_EVAL_BOOT_HARNESS_REGISTRY_EMPTY",
        contributionName: "harness",
        entryKey: "harness",
        level: "error",
        message: `harness registry has no entries${formatShadowCause(input.builtInShadow, "harness")}`,
      },
    ];
  }

  const projectRecords = getProjectHarnessRecords(input.records);
  if (projectRecords.length > EMPTY_COUNT || input.records.length === 1) {
    return [];
  }

  if (input.builtInDefaultHarnessName === undefined) {
    return [
      {
        code: "ROUTEKIT_EVAL_BOOT_HARNESS_DEFAULT_MISSING",
        contributionName: "harness",
        entryKey: "harness",
        level: "error",
        message: "No default harness is available",
      },
    ];
  }

  return input.records.some(
    (record) =>
      record.origin === "builtIn" &&
      record.entry.name === input.builtInDefaultHarnessName
  )
    ? []
    : [
        {
          code: "ROUTEKIT_EVAL_BOOT_HARNESS_DEFAULT_MISSING",
          contributionName: "harness",
          entryKey: "harness",
          level: "error",
          message: `harness built-in default "${input.builtInDefaultHarnessName}" is missing`,
        },
      ];
};

const formatHarnessNames = (names: readonly string[]): string =>
  names.map((name) => `"${name}"`).join(", ");

const formatHarnessRegistryWarnings = (input: {
  readonly records: RegisteredFeatureContributions["harnesses"]["records"];
}): readonly BootDiagnostic[] => {
  const projectRecords = getProjectHarnessRecords(input.records);
  return projectRecords.length > 1
    ? [
        {
          code: "ROUTEKIT_EVAL_BOOT_HARNESS_DEFAULT_AMBIGUOUS",
          contributionName: "harness",
          entryKey: "harness",
          level: "warning",
          message: `harness default is ambiguous; specify one of ${formatHarnessNames(projectRecords.map((record) => record.entry.name))} by name`,
        },
      ]
    : [];
};

const makeBuiltInHarnessAvailabilityDiagnostics = (
  messages: readonly string[]
): readonly BootDiagnostic[] =>
  messages.map((message) => ({
    code: "ROUTEKIT_EVAL_BOOT_BUILT_IN_HARNESS_UNAVAILABLE",
    contributionName: "harness",
    entryKey: "harness",
    level: "warning",
    message,
  }));

/**
 * Boot diagnostics that leave the runtime unable to serve any turn at all, as
 * opposed to disabling one feature or one of its capabilities.
 *
 * Everything else degrades: the failing contribution is skipped, its diagnostic
 * is logged, and the rest of the workspace boots. A workspace carrying a feature
 * frozen against a removed contract (the `commandHook` case) must not cost the
 * user their whole intern — the stale `/name` is simply absent and every other
 * turn runs. `routekit-eval features validate` and `routekit-eval ci boot-check` still fail on any
 * error, because "is this workspace clean" and "can this runtime serve a turn"
 * are different questions and only the second one gates boot.
 *
 * A new capability kind therefore degrades by default, which is the safe
 * direction; a genuinely unrecoverable condition has to be added here
 * deliberately.
 */
const RUNTIME_FATAL_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "ROUTEKIT_EVAL_BOOT_DEPENDENCY_CYCLE",
  "ROUTEKIT_EVAL_BOOT_HARNESS_DEFAULT_MISSING",
  "ROUTEKIT_EVAL_BOOT_HARNESS_REGISTRY_EMPTY",
]);

const isRuntimeFatalDiagnostic = (diagnostic: BootDiagnostic): boolean =>
  diagnostic.level === "error" &&
  RUNTIME_FATAL_DIAGNOSTIC_CODES.has(diagnostic.code);

/** The error diagnostics that must stop the runtime from booting. */
const runtimeFatalBootDiagnostics = (
  diagnostics: readonly BootDiagnostic[]
): readonly BootDiagnostic[] => diagnostics.filter(isRuntimeFatalDiagnostic);

/**
 * The error diagnostics the runtime boots through: something is broken and the
 * user should be told, but the capability it belongs to is the only casualty.
 */
const degradedBootDiagnostics = (
  diagnostics: readonly BootDiagnostic[]
): readonly BootDiagnostic[] =>
  diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "error" && !isRuntimeFatalDiagnostic(diagnostic)
  );

export const makeBootDiagnosticRecords = (input: {
  readonly dependencyDiagnostics: readonly DependencyDiagnostic[];
  readonly features: readonly ResolvedFeature[];
  readonly featureLoaderWarnings: readonly FeatureLoaderWarning[];
  readonly imported: ImportedFeatureContributions;
  readonly options: FeatureBootOptions;
  readonly registered: RegisteredFeatureContributions;
}): readonly BootDiagnostic[] => [
  ...makeDisabledFeatureDiagnostics(input.features),
  ...makeFeatureWarningDiagnostics(input.features),
  ...makeRootFeatureWarningDiagnostics(input.featureLoaderWarnings),
  ...makeDiscoveredOnlyContributionDiagnostics(input.features),
  ...makeDependencyDiagnosticRecords(input.dependencyDiagnostics),
  ...makeBuiltInHarnessAvailabilityDiagnostics(
    input.options.builtInHarnessDiagnostics ?? []
  ),
  ...input.registered.builtInShadow.diagnostics,
  ...formatHarnessRegistryDiagnostics({
    builtInDefaultHarnessName: input.options.builtInDefaultHarnessName,
    builtInShadow: input.registered.builtInShadow,
    records: input.registered.harnesses.records,
  }),
  ...formatHarnessRegistryWarnings({
    records: input.registered.harnesses.records,
  }),
  ...input.imported.apis.diagnostics,
  ...(input.imported.hooks?.diagnostics ?? []),
  ...input.imported.dbs.diagnostics,
  ...input.imported.chats.diagnostics,
  ...input.imported.harnesses.diagnostics,
  ...input.imported.prompts.diagnostics,
  ...input.imported.modelProviders.diagnostics,
  ...input.imported.schedules.diagnostics,
  ...input.imported.commands.diagnostics,
  ...input.imported.skills.diagnostics,
  ...input.registered.apis.diagnostics,
  ...(input.registered.hooks?.diagnostics ?? []),
  ...input.registered.dbs.diagnostics,
  ...input.registered.chats.diagnostics,
  ...input.registered.harnesses.diagnostics,
  ...input.registered.prompts.diagnostics,
  ...input.registered.modelProviders.diagnostics,
  ...input.registered.commands.diagnostics,
  ...input.registered.schedules.diagnostics,
  ...input.registered.skills.diagnostics,
];

export {
  degradedBootDiagnostics,
  formatBootDiagnostic,
  formatBootDiagnosticMessages,
  makeBootDiagnostics,
  makeBootWarnings,
  runtimeFatalBootDiagnostics,
};
