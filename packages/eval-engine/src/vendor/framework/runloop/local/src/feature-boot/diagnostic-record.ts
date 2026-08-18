import type { BootDiagnostic } from "./diagnostic-types.ts";

export const makeContributionBootDiagnostic = (input: {
  readonly code: string;
  readonly contributionName?: string | undefined;
  readonly entryKey?: string | undefined;
  readonly featureId?: string | undefined;
  readonly level: BootDiagnostic["level"];
  readonly message: string;
}): BootDiagnostic => ({
  code: input.code,
  contributionName: input.contributionName,
  entryKey: input.entryKey,
  featureId: input.featureId,
  level: input.level,
  message: input.message,
});

const makeContributionBootDiagnostics = (input: {
  readonly code: string;
  readonly contributionName?: string;
  readonly entryKey?: string;
  readonly featureId?: string | undefined;
  readonly level: BootDiagnostic["level"];
  readonly messages: readonly string[];
}): readonly BootDiagnostic[] =>
  input.messages.map((message) =>
    makeContributionBootDiagnostic({
      code: input.code,
      contributionName: input.contributionName,
      entryKey: input.entryKey,
      featureId: input.featureId,
      level: input.level,
      message,
    })
  );

export const makeImportBootDiagnostics = (
  contributionName: string,
  messages: readonly string[],
  featureId?: string
): readonly BootDiagnostic[] =>
  makeContributionBootDiagnostics({
    code: `ORI_BOOT_IMPORT_${contributionName.toUpperCase()}`,
    contributionName,
    entryKey: contributionName,
    featureId,
    level: "error",
    messages,
  });

// Warning-level import notes: the contribution still registered, but degraded
// (e.g. a managed skill pointer resolving through its committed fallback body).
export const makeImportBootWarnings = (
  contributionName: string,
  messages: readonly string[],
  featureId?: string
): readonly BootDiagnostic[] =>
  makeContributionBootDiagnostics({
    code: `ORI_BOOT_IMPORT_${contributionName.toUpperCase()}`,
    contributionName,
    entryKey: contributionName,
    featureId,
    level: "warning",
    messages,
  });

/**
 * A project feature took over a built-in feature's name, so every contribution
 * that built-in registered was dropped (RFC 0003
 * runtime-events-and-failure-policy.md). Warning level rather than debug: for a
 * workspace that already had the shadowing feature, this is the boot where the
 * built-in's capability silently stops being there.
 */
export const makeBuiltInShadowDiagnostic = (input: {
  readonly builtInFeatureId: string;
  readonly kinds: readonly string[];
  readonly projectFeatureId: string;
}): BootDiagnostic =>
  makeContributionBootDiagnostic({
    code: "ORI_BOOT_SHADOW_BUILTIN",
    entryKey: input.builtInFeatureId,
    featureId: input.projectFeatureId,
    level: "warning",
    message: `feature "${input.projectFeatureId}" shadows built-in feature "${input.builtInFeatureId}" (${input.kinds.join(", ")} disabled)`,
  });

export const makeRegistryBootDiagnostic = (input: {
  readonly contributionName: string;
  readonly featureId?: string;
  readonly message: string;
}): BootDiagnostic =>
  makeContributionBootDiagnostic({
    code: `ORI_BOOT_REGISTRY_${input.contributionName.toUpperCase()}`,
    contributionName: input.contributionName,
    entryKey: input.contributionName,
    featureId: input.featureId,
    level: "error",
    message: input.message,
  });
