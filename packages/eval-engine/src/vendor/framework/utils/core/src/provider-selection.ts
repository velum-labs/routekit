import type {
  BuiltInPriorityScan,
  ProviderCandidate,
  ProviderSelectionDiagnostic,
  ProviderSelectionInput,
  ProviderSelectionResult,
} from "./provider-selection-support.ts";

import {
  DiagnosticLevel,
  findCandidate,
  formatNames,
  makeMissingDefaultDiagnostic,
  makeNoAvailableDefaultDiagnostic,
  makeNoAvailableDefaultWarning,
  makeNoDefaultDiagnostic,
  ProviderOrigin,
  scanBuiltInPriority,
  selectFromGroup,
} from "./provider-selection-support.ts";

const selectNamedProvider = <Value, Name extends string>(input: {
  readonly candidates: readonly ProviderCandidate<Value, Name>[];
  readonly code: string;
  readonly kind: string;
  readonly name: Name;
  readonly reason: string;
}): ProviderSelectionResult<Value, Name> => {
  const selected = findCandidate(input.candidates, input.name);
  if (selected !== undefined) {
    return {
      diagnostics: [],
      selected,
      warnings: [],
    };
  }

  return {
    diagnostics: [
      {
        code: input.code,
        kind: input.kind,
        level: DiagnosticLevel.Error,
        message: `${input.kind} ${input.reason} default "${input.name}" is unavailable`,
        name: input.name,
      },
    ],
    warnings: [],
  };
};

const resolveNamedBuiltInDefault = <Value, Name extends string>(
  input: ProviderSelectionInput<Value, Name>,
  name: Name,
  warnings: readonly ProviderSelectionDiagnostic<Name>[]
): ProviderSelectionResult<Value, Name> => {
  const selected = findCandidate(input.candidates, name);
  if (selected !== undefined && selected.origin === ProviderOrigin.BuiltIn) {
    return {
      diagnostics: [],
      selected,
      warnings: [...warnings],
    };
  }
  return {
    diagnostics: [
      makeMissingDefaultDiagnostic({
        kind: input.kind,
        name,
      }),
    ],
    warnings: [...warnings],
  };
};

// Extracted from `resolveProviderSelection` to keep that function's branch count low.
const resolveProjectSelection = <Value, Name extends string>(
  input: ProviderSelectionInput<Value, Name>,
  warnings: readonly ProviderSelectionDiagnostic<Name>[]
): ProviderSelectionResult<Value, Name> | undefined => {
  const projectDefaults = input.candidates.filter(
    (candidate) => candidate.projectDefault === true
  );
  const defaultPick = selectFromGroup(input.kind, projectDefaults, warnings);
  if (defaultPick !== undefined) {
    return defaultPick;
  }

  const projectCandidates = input.candidates.filter(
    (candidate) => candidate.origin === ProviderOrigin.Project
  );
  return selectFromGroup(input.kind, projectCandidates, warnings);
};

export const formatProviderSelectionFailure = <
  Value,
  Name extends string = string,
>(
  kind: string,
  selection?: ProviderSelectionResult<Value, Name>
): string => {
  const ambiguity = selection?.warnings.find(
    (warning) => warning.code === "ORI_PROVIDER_DEFAULT_AMBIGUOUS"
  );
  if (ambiguity !== undefined) {
    return `Ambiguous ${kind} default; address one of ${formatNames(ambiguity.candidateNames ?? [])} by name`;
  }

  const diagnostic = selection?.diagnostics.at(0);
  return diagnostic?.message ?? `No default ${kind} is available`;
};

// When none is available, fall back to the priority head — keeping boot valid so
// the missing binary surfaces at dispatch, not as a fatal boot error (the
// pre-optimistic contract). Only a priority order with no registered built-in at
// all is a genuine no-default error (RFC 0006).
const resolveOptimisticBuiltInDefault = <Value, Name extends string>(
  input: ProviderSelectionInput<Value, Name>,
  warnings: readonly ProviderSelectionDiagnostic<Name>[]
): ProviderSelectionResult<Value, Name> => {
  const scan: BuiltInPriorityScan<Value, Name> = scanBuiltInPriority(input);
  const baseWarnings = [...warnings, ...scan.skipped];

  if (scan.available !== undefined) {
    return {
      diagnostics: [],
      selected: scan.available,
      warnings: baseWarnings,
    };
  }

  if (scan.fallbackHead !== undefined) {
    return {
      diagnostics: [],
      selected: scan.fallbackHead,
      warnings: [
        ...baseWarnings,
        makeNoAvailableDefaultWarning(
          input.kind,
          input.builtInDefaultPriority ?? [],
          scan.fallbackHead.name
        ),
      ],
    };
  }

  return {
    diagnostics: [
      makeNoAvailableDefaultDiagnostic(
        input.kind,
        input.builtInDefaultPriority ?? []
      ),
    ],
    warnings: baseWarnings,
  };
};

// Built-in tiers are ordered lowest-precedence first per
// [Runtime Registries and Selection]. Extracted from `resolveProviderSelection` to
// keep that function's branch count low.
const resolveBuiltInSelection = <Value, Name extends string>(
  input: ProviderSelectionInput<Value, Name>,
  warnings: readonly ProviderSelectionDiagnostic<Name>[]
): ProviderSelectionResult<Value, Name> => {
  if (
    input.builtInDefaultPriority !== undefined &&
    input.builtInDefaultPriority.length > 0
  ) {
    return resolveOptimisticBuiltInDefault(input, warnings);
  }

  const { builtInDefaultName } = input;
  if (builtInDefaultName !== undefined) {
    return resolveNamedBuiltInDefault(input, builtInDefaultName, warnings);
  }

  const builtInDefaults = input.candidates.filter(
    (candidate) => candidate.builtInDefault === true
  );
  return (
    selectFromGroup(input.kind, builtInDefaults, warnings) ?? {
      diagnostics: [makeNoDefaultDiagnostic(input.kind)],
      warnings: [...warnings],
    }
  );
};

export const resolveProviderSelection = <Value, Name extends string = string>(
  input: ProviderSelectionInput<Value, Name>
): ProviderSelectionResult<Value, Name> => {
  if (input.explicitName !== undefined) {
    return selectNamedProvider({
      candidates: input.candidates,
      code: "ORI_PROVIDER_EXPLICIT_MISSING",
      kind: input.kind,
      name: input.explicitName,
      reason: "explicit",
    });
  }

  const warnings: ProviderSelectionDiagnostic<Name>[] = [];
  if (input.storedPreferenceName !== undefined) {
    const selected = findCandidate(
      input.candidates,
      input.storedPreferenceName
    );
    if (selected !== undefined) {
      return {
        diagnostics: [],
        selected,
        warnings,
      };
    }
    warnings.push({
      code: "ORI_PROVIDER_STORED_PREFERENCE_MISSING",
      kind: input.kind,
      level: DiagnosticLevel.Warning,
      message: `${input.kind} stored default "${input.storedPreferenceName}" is unavailable`,
      name: input.storedPreferenceName,
    });
  }

  const projectSelection = resolveProjectSelection(input, warnings);
  if (projectSelection !== undefined) {
    return projectSelection;
  }

  if (input.candidates.length === 1) {
    return {
      diagnostics: [],
      selected: input.candidates[0],
      warnings,
    };
  }

  return resolveBuiltInSelection(input, warnings);
};
