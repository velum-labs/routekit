import type { ValueOf } from "./types.ts";

const ProviderOrigin = {
  BuiltIn: "builtIn",
  Project: "project",
} as const;
type ProviderOrigin = ValueOf<typeof ProviderOrigin>;

const DiagnosticLevel = {
  Error: "error",
  Info: "info",
  Warning: "warning",
} as const;
type DiagnosticLevel = ValueOf<typeof DiagnosticLevel>;

interface ProviderCandidate<Value, Name extends string = string> {
  readonly builtInDefault?: boolean | undefined;
  readonly featureId: string;
  readonly kind: string;
  readonly name: Name;
  readonly origin: ProviderOrigin;
  readonly projectDefault?: boolean | undefined;
  readonly value: Value;
}

interface ProviderSelectionDiagnostic<Name extends string = string> {
  readonly candidateNames?: readonly Name[];
  readonly code: string;
  readonly kind: string;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly name?: Name | "default";
}

interface ProviderSelectionInput<Value, Name extends string = string> {
  readonly builtInDefaultName?: Name | undefined;
  /**
   * Ordered built-in-default priority for optimistic selection (RFC 0003 §Default
   * selection, RFC 0006). When set, the built-in-default tier walks this list and
   * selects the first candidate that is both registered as a built-in and — if
   * `isBuiltInAvailable` is provided — reported available. Supersedes
   * `builtInDefaultName` for that tier. The head is the preferred default (e.g.
   * the `routekit-eval.md` `harness` frontmatter, or the bundled default when unset).
   */
  readonly builtInDefaultPriority?: readonly Name[] | undefined;
  readonly candidates: readonly ProviderCandidate<Value, Name>[];
  readonly explicitName?: Name | undefined;
  /**
   * Availability predicate for the optimistic built-in-default walk. A candidate
   * for which this returns `false` is skipped in favor of the next entry in
   * priority order. When omitted, every built-in is considered available — which
   * preserves the pre-optimistic behavior for kinds that do not probe availability.
   */
  readonly isBuiltInAvailable?: ((name: Name) => boolean) | undefined;
  readonly kind: string;
  readonly storedPreferenceName?: Name | undefined;
}

interface ProviderSelectionResult<Value, Name extends string = string> {
  readonly diagnostics: readonly ProviderSelectionDiagnostic<Name>[];
  readonly selected?: ProviderCandidate<Value, Name> | undefined;
  readonly warnings: readonly ProviderSelectionDiagnostic<Name>[];
}

interface BuiltInPriorityScan<Value, Name extends string> {
  readonly available?: ProviderCandidate<Value, Name> | undefined;
  readonly fallbackHead?: ProviderCandidate<Value, Name> | undefined;
  readonly skipped: readonly ProviderSelectionDiagnostic<Name>[];
}

const findCandidate = <Value, Name extends string>(
  candidates: readonly ProviderCandidate<Value, Name>[],
  name: Name
): ProviderCandidate<Value, Name> | undefined =>
  candidates.find((candidate) => candidate.name === name);

const makeMissingDefaultDiagnostic = <Name extends string>(input: {
  readonly kind: string;
  readonly name: Name;
}): ProviderSelectionDiagnostic<Name> => ({
  code: "ROUTEKIT_EVAL_PROVIDER_DEFAULT_MISSING",
  kind: input.kind,
  level: DiagnosticLevel.Error,
  message: `${input.kind} built-in default "${input.name}" is missing`,
  name: input.name,
});

const makeNoDefaultDiagnostic = <Name extends string>(
  kind: string
): ProviderSelectionDiagnostic<Name> => ({
  code: "ROUTEKIT_EVAL_PROVIDER_DEFAULT_MISSING",
  kind,
  level: DiagnosticLevel.Error,
  message: `No default ${kind} is available`,
  name: "default",
});

const makeUnavailableDefaultWarning = <Name extends string>(
  kind: string,
  name: Name
): ProviderSelectionDiagnostic<Name> => ({
  code: "ROUTEKIT_EVAL_PROVIDER_DEFAULT_UNAVAILABLE",
  kind,
  level: DiagnosticLevel.Warning,
  message: `${kind} built-in default "${name}" is not available; trying the next in priority order`,
  name,
});

const scanBuiltInPriority = <Value, Name extends string>(
  input: ProviderSelectionInput<Value, Name>
): BuiltInPriorityScan<Value, Name> => {
  const isAvailable = input.isBuiltInAvailable ?? ((): boolean => true);
  const skipped: ProviderSelectionDiagnostic<Name>[] = [];
  let fallbackHead: ProviderCandidate<Value, Name> | undefined;

  for (const name of input.builtInDefaultPriority ?? []) {
    const candidate = findCandidate(input.candidates, name);
    if (
      candidate === undefined ||
      candidate.origin !== ProviderOrigin.BuiltIn
    ) {
      continue;
    }
    fallbackHead ??= candidate;
    if (isAvailable(name)) {
      return {
        available: candidate,
        fallbackHead,
        skipped,
      };
    }
    skipped.push(makeUnavailableDefaultWarning(input.kind, name));
  }

  return {
    fallbackHead,
    skipped,
  };
};

const formatCandidateNames = <Value, Name extends string>(
  candidates: readonly ProviderCandidate<Value, Name>[]
): string => candidates.map((candidate) => `"${candidate.name}"`).join(", ");

const makeAmbiguousDefaultWarning = <Value, Name extends string>(
  kind: string,
  candidates: readonly ProviderCandidate<Value, Name>[]
): ProviderSelectionDiagnostic<Name> => ({
  candidateNames: candidates.map((candidate) => candidate.name),
  code: "ROUTEKIT_EVAL_PROVIDER_DEFAULT_AMBIGUOUS",
  kind,
  level: DiagnosticLevel.Warning,
  message: `${kind} default is ambiguous; specify one of ${formatCandidateNames(candidates)} by name`,
  name: "default",
});

const selectFromGroup = <Value, Name extends string>(
  kind: string,
  group: readonly ProviderCandidate<Value, Name>[],
  warnings: readonly ProviderSelectionDiagnostic<Name>[]
): ProviderSelectionResult<Value, Name> | undefined => {
  if (group.length === 1) {
    return {
      diagnostics: [],
      selected: group[0],
      warnings: [...warnings],
    };
  }
  if (group.length > 1) {
    return {
      diagnostics: [],
      warnings: [...warnings, makeAmbiguousDefaultWarning(kind, group)],
    };
  }
  return undefined;
};

const formatNames = (names: readonly string[]): string =>
  names.map((name) => `"${name}"`).join(", ");

const makeNoAvailableDefaultDiagnostic = <Name extends string>(
  kind: string,
  priority: readonly Name[]
): ProviderSelectionDiagnostic<Name> => ({
  candidateNames: priority,
  code: "ROUTEKIT_EVAL_PROVIDER_DEFAULT_MISSING",
  kind,
  level: DiagnosticLevel.Error,
  message: `No ${kind} is available; tried ${formatNames(priority)} in priority order`,
  name: "default",
});

const makeNoAvailableDefaultWarning = <Name extends string>(
  kind: string,
  priority: readonly Name[],
  fallback: Name
): ProviderSelectionDiagnostic<Name> => ({
  candidateNames: priority,
  code: "ROUTEKIT_EVAL_PROVIDER_DEFAULT_UNAVAILABLE",
  kind,
  level: DiagnosticLevel.Warning,
  message: `No ${kind} binary was detected (tried ${formatNames(priority)}); defaulting to "${fallback}" — it must be installed before a run can dispatch`,
  name: fallback,
});

export {
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
};
export type {
  BuiltInPriorityScan,
  ProviderCandidate,
  ProviderSelectionDiagnostic,
  ProviderSelectionInput,
  ProviderSelectionResult,
};
