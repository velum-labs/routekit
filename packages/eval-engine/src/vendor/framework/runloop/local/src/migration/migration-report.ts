import { Data } from "effect";

import type {
  CapabilityLifecycle,
  CapabilityShapeChange,
} from "../../../../contracts/internal/src/author-schemas/capability-lifecycle.ts";
import type { Capability } from "../../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import type { BootDiagnostic } from "../feature-boot/diagnostic-types.ts";
import type { FeatureDefinition } from "../feature-boot/types.ts";
import type { ValueOf } from "../../../../utils/core/src/types.ts";

import {
  CAPABILITY_LIFECYCLE,
  FEATURE_MODULE_SHAPE_CHANGES,
} from "../../../../contracts/internal/src/author-schemas/capability-lifecycle.ts";
import {
  CAPABILITY_KINDS,
  Capability as CapabilityEnum,
} from "../../../../contracts/internal/src/author-schemas/feature-manifest.ts";

/**
 * Migration report (RFC 0002 Feature Compatibility and Migration).
 *
 * The report combines two inputs — neither sufficient alone:
 *   1. live loader diagnostics (`BootDiagnostic[]` from `inspectDefinition`) —
 *      the authority for what actually fails to load on the running CLI;
 *   2. the workspace's recorded generating CLI version (`ori.md` `version`)
 *      plus the bundled `CAPABILITY_LIFECYCLE` registry — the context that
 *      explains *why* a diagnostic appeared now and *which* CLI version
 *      introduced the rule.
 *
 * It is **diagnostic-only**: this module computes a classification, it never
 * mutates a workspace file.
 */

/** Severity buckets the command layer maps to exit codes / glyphs. */
const MigrationSeverity = {
  Blocker: "blocker",
  Warning: "warning",
} as const;
type MigrationSeverity = ValueOf<typeof MigrationSeverity>;

/**
 * A classified migration finding, as a tagged union — each variant carries
 * exactly the fields it needs, so there are no impossible field combinations to
 * guard. Consume with `MigrationFinding.$match` for exhaustive handling.
 *
 *   - `RemovedCapability` — a capability removed as of a CLI version ≤ running
 *     (blocker). Presence-driven: the kind no longer loads.
 *   - `DeprecatedCapability` — a deprecated-but-still-loadable capability in use
 *     (warning). Presence-driven.
 *   - `BreakingShapeChange` — a live loader failure that matches a declared
 *     `shapeChanges` rule introduced after the workspace's version (blocker).
 *     This is the sniffer case.
 *   - `LoaderDiagnostic` — any other live loader error, surfaced verbatim
 *     (blocker); never suppressed just because the registry has no entry.
 */
type MigrationFinding = Data.TaggedEnum<{
  RemovedCapability: {
    readonly capability: Capability;
    readonly removedIn: string;
    readonly message: string;
  };
  DeprecatedCapability: {
    readonly capability: Capability;
    readonly deprecatedIn: string;
    readonly message: string;
  };
  BreakingShapeChange: {
    readonly capability: Capability | undefined;
    readonly rule: string;
    readonly introducedIn: string;
    readonly featureId: string | undefined;
    readonly file: string | undefined;
    readonly message: string;
  };
  LoaderDiagnostic: {
    readonly capability: Capability | undefined;
    readonly featureId: string | undefined;
    readonly file: string | undefined;
    readonly message: string;
  };
}>;

const MigrationFinding = Data.taggedEnum<MigrationFinding>();

/** The severity of a finding — derived from its tag, not stored. */
const findingSeverity = (finding: MigrationFinding): MigrationSeverity =>
  MigrationFinding.$match(finding, {
    RemovedCapability: () => MigrationSeverity.Blocker,
    DeprecatedCapability: () => MigrationSeverity.Warning,
    BreakingShapeChange: () => MigrationSeverity.Blocker,
    LoaderDiagnostic: () => MigrationSeverity.Blocker,
  });

interface MigrationReport {
  /** The generating CLI version recorded in `ori.md`, or undefined if absent. */
  readonly generatedWithVersion: string | undefined;
  /** The CLI version producing this report. */
  readonly runningVersion: string;
  readonly findings: readonly MigrationFinding[];
  /** True when any finding is a blocker (the command must exit non-zero). */
  readonly hasBlocker: boolean;
}

/**
 * Compare two SemVer-core strings ("MAJOR.MINOR.PATCH") numerically, segment by
 * segment. A plain string `>=` is WRONG here because versions mix widths (e.g.
 * "0.3.0" vs "0.27.0"): lexically "0.3.0" > "0.27.0", but in SemVer 0.3.0
 * precedes 0.27.0. Prerelease/build metadata is irrelevant for these core-only
 * lifecycle versions, so it is stripped before the numeric compare.
 *
 * Returns <0 if `a` precedes `b`, 0 if equal, >0 if `a` is after `b`.
 */
const compareVersions = (a: string, b: string): number => {
  const coreA = (a.split(/[-+]/u)[0] ?? "")
    .split(".")
    .map((segment) => Number.parseInt(segment, 10));
  const coreB = (b.split(/[-+]/u)[0] ?? "")
    .split(".")
    .map((segment) => Number.parseInt(segment, 10));
  const length = Math.max(coreA.length, coreB.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (coreA[index] ?? 0) - (coreB[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
};

// A contribution import failure carries the stable code `ORI_BOOT_IMPORT_<KIND>`
// (see `makeImportBootDiagnostics`). This prefix lets the report recognise an
// authoring-shape failure for a specific capability kind without string-matching
// the human message.
const IMPORT_DIAGNOSTIC_PREFIX = "ORI_BOOT_IMPORT_";

/** Resolve the capability kind a diagnostic concerns, if it is a known kind. */
const capabilityForDiagnostic = (
  diagnostic: BootDiagnostic
): Capability | undefined => {
  const candidate = diagnostic.contributionName ?? diagnostic.entryKey;
  return CAPABILITY_KINDS.find((kind) => kind === candidate);
};

/**
 * Find the shape-change entry (from any declared list — a capability's own
 * `shapeChanges` or the module-level {@link FEATURE_MODULE_SHAPE_CHANGES})
 * that explains a loader failure: a rule whose `since` is strictly newer than
 * the version the workspace was generated with (so the rule did not exist
 * when it was authored) and no newer than the running CLI (so it is in force
 * now).
 *
 * When the workspace records no version, we cannot prove the rule post-dates
 * it, so we do not claim a shape-change match (the failure still surfaces as
 * a plain loader diagnostic).
 */
const matchShapeChange = (
  changes: readonly CapabilityShapeChange[],
  generatedWithVersion: string | undefined,
  runningVersion: string
): CapabilityShapeChange | undefined => {
  if (generatedWithVersion === undefined) {
    return undefined;
  }
  return changes.find(
    (change) =>
      compareVersions(change.since, generatedWithVersion) > 0 &&
      compareVersions(change.since, runningVersion) <= 0
  );
};

const isImportFailure = (diagnostic: BootDiagnostic): boolean =>
  diagnostic.level === "error" &&
  diagnostic.code.startsWith(IMPORT_DIAGNOSTIC_PREFIX);

// The module-level (not capability-scoped) sniffer case: a `feature.ts` using
// the removed whole-module `export default {...} satisfies FeatureModule`
// form (formerly ORI-167) reports this code rather than a capability-scoped
// `ORI_BOOT_IMPORT_<KIND>` one, since the failure is not about any single
// contribution's value shape.
const FEATURE_MODULE_IMPORT_CODE = "ORI_BOOT_IMPORT_FEATURE_MODULE";

/** Build the `BreakingShapeChange` finding a matched shape change explains. */
const breakingShapeChangeFinding = (input: {
  readonly capability: Capability | undefined;
  readonly diagnostic: BootDiagnostic;
  readonly generatedWithVersion: string | undefined;
  readonly shapeChange: CapabilityShapeChange;
}): MigrationFinding =>
  MigrationFinding.BreakingShapeChange({
    capability: input.capability,
    rule: input.shapeChange.rule,
    introducedIn: input.shapeChange.since,
    featureId: input.diagnostic.featureId,
    file: input.diagnostic.file,
    message: `${input.diagnostic.message} (rule: ${input.shapeChange.rule}, introduced in CLI ${input.shapeChange.since}${
      input.generatedWithVersion === undefined
        ? ""
        : `; this workspace was generated against ${input.generatedWithVersion}`
    })`,
  });

/**
 * The capability kinds a resolved workspace actually contributes — a kind is
 * "in use" when it has at least one registered entry. This is the presence
 * signal the report needs to detect deprecated/removed kinds that still load
 * (and so emit no error diagnostic). `db` and `modelProviders` contributions
 * exist on the definition but are not members of the closed `Capability` enum,
 * so they are intentionally not mapped here.
 */
const capabilitiesInUse = (
  definition: FeatureDefinition
): readonly Capability[] => {
  const presence: readonly (readonly [Capability, number])[] = [
    [CapabilityEnum.Harness, definition.harnesses.length],
    [CapabilityEnum.Chat, definition.chatEntries.length],
    [CapabilityEnum.Schedule, definition.scheduleEntries.length],
    [CapabilityEnum.Api, definition.apiEntries.length],
    [CapabilityEnum.Prompt, definition.promptEntries.length],
    [CapabilityEnum.Skill, definition.skillEntries.length],
    [CapabilityEnum.Command, definition.commandEntries.length],
  ];
  return presence
    .filter(([, count]) => count > 0)
    .map(([capability]) => capability);
};

/**
 * Presence-driven findings: removed/deprecated capabilities the workspace
 * actually uses. A deprecated kind still loads (no error diagnostic), so
 * capability presence — not the diagnostic stream — is the only signal.
 */
const presenceFindings = (
  registry: Readonly<Record<Capability, CapabilityLifecycle>>,
  inUse: ReadonlySet<Capability>,
  runningVersion: string
): {
  readonly findings: readonly MigrationFinding[];
  readonly reportedRemovals: ReadonlySet<Capability>;
} => {
  const findings: MigrationFinding[] = [];
  const reportedRemovals = new Set<Capability>();
  for (const kind of CAPABILITY_KINDS) {
    if (!inUse.has(kind)) {
      continue;
    }
    const lifecycle = registry[kind];
    if (
      lifecycle.removedIn !== undefined &&
      compareVersions(lifecycle.removedIn, runningVersion) <= 0
    ) {
      reportedRemovals.add(kind);
      findings.push(
        MigrationFinding.RemovedCapability({
          capability: kind,
          removedIn: lifecycle.removedIn,
          message: `capability "${kind}" was removed in CLI ${lifecycle.removedIn} and no longer loads`,
        })
      );
    } else if (
      lifecycle.deprecatedIn !== undefined &&
      compareVersions(lifecycle.deprecatedIn, runningVersion) <= 0
    ) {
      findings.push(
        MigrationFinding.DeprecatedCapability({
          capability: kind,
          deprecatedIn: lifecycle.deprecatedIn,
          message: `capability "${kind}" is deprecated as of CLI ${lifecycle.deprecatedIn} and scheduled for removal`,
        })
      );
    }
  }
  return {
    findings,
    reportedRemovals,
  };
};

/**
 * Classify one live loader error into a finding, or `undefined` to skip it. A
 * matching declared shape change makes it the sniffer case; otherwise the
 * loader's own message is surfaced verbatim, never suppressed.
 *
 * `reportedRemovals` is the set of kinds for which Pass 1 already emitted a
 * `RemovedCapability` finding. We skip a diagnostic ONLY when its removal was
 * actually reported there — never merely because the kind is removed. Otherwise
 * a removed kind that failed to load before registering entries (so it is absent
 * from `capabilitiesInUse`, and Pass 1 emitted nothing) would have its real
 * loader error silently dropped.
 */
interface DiagnosticClassificationContext {
  readonly registry: Readonly<Record<Capability, CapabilityLifecycle>>;
  readonly reportedRemovals: ReadonlySet<Capability>;
  readonly generatedWithVersion: string | undefined;
  readonly runningVersion: string;
}

// The declared shape-change list to check a diagnostic against: the
// module-level list for the whole-module import form (no single capability
// to blame), or the resolved capability's own `shapeChanges` otherwise.
const shapeChangesForDiagnostic = (
  diagnostic: BootDiagnostic,
  capability: Capability | undefined,
  registry: DiagnosticClassificationContext["registry"]
): readonly CapabilityShapeChange[] | undefined => {
  if (diagnostic.code === FEATURE_MODULE_IMPORT_CODE) {
    return FEATURE_MODULE_SHAPE_CHANGES;
  }
  return capability === undefined
    ? undefined
    : (registry[capability].shapeChanges ?? []);
};

const classifyDiagnostic = (
  diagnostic: BootDiagnostic,
  context: DiagnosticClassificationContext
): MigrationFinding | undefined => {
  const capability = capabilityForDiagnostic(diagnostic);
  if (capability !== undefined && context.reportedRemovals.has(capability)) {
    return undefined;
  }

  const changes = shapeChangesForDiagnostic(
    diagnostic,
    capability,
    context.registry
  );
  const shapeChange =
    changes !== undefined && isImportFailure(diagnostic)
      ? matchShapeChange(
          changes,
          context.generatedWithVersion,
          context.runningVersion
        )
      : undefined;

  if (shapeChange !== undefined) {
    return breakingShapeChangeFinding({
      capability,
      diagnostic,
      generatedWithVersion: context.generatedWithVersion,
      shapeChange,
    });
  }
  return MigrationFinding.LoaderDiagnostic({
    capability,
    featureId: diagnostic.featureId,
    file: diagnostic.file,
    message: diagnostic.message,
  });
};

/**
 * Build the migration report from live loader diagnostics and the version gap.
 *
 * Pure: no IO, no Effect. The caller supplies:
 *   - `diagnostics` — the error/warning records from `inspectDefinition`;
 *   - `capabilitiesInUse` — the capability kinds the workspace's features
 *     actually contribute (from the resolved definition), needed to detect
 *     deprecated/removed kinds that still load (and so emit no error);
 *   - `generatedWithVersion` — the `ori.md` `version` stamp (or undefined);
 *   - `runningVersion` — the CLI producing the report.
 */
export const buildMigrationReport = (input: {
  readonly diagnostics: readonly BootDiagnostic[];
  readonly capabilitiesInUse: readonly Capability[];
  readonly generatedWithVersion: string | undefined;
  readonly runningVersion: string;
  readonly lifecycle?: Readonly<Record<Capability, CapabilityLifecycle>>;
}): MigrationReport => {
  const registry = input.lifecycle ?? CAPABILITY_LIFECYCLE;
  const { generatedWithVersion, runningVersion } = input;
  const inUse = new Set(input.capabilitiesInUse);

  const presence = presenceFindings(registry, inUse, runningVersion);
  const findings: MigrationFinding[] = [...presence.findings];

  // Pass 2 — classify each live loader error. A removal already reported by
  // Pass 1 is skipped to avoid double-counting; a removed kind that Pass 1 did
  // NOT report (absent from capabilitiesInUse) still surfaces its loader error.
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.level !== "error") {
      continue;
    }
    const finding = classifyDiagnostic(diagnostic, {
      generatedWithVersion,
      registry,
      reportedRemovals: presence.reportedRemovals,
      runningVersion,
    });
    if (finding !== undefined) {
      findings.push(finding);
    }
  }

  return {
    generatedWithVersion,
    runningVersion,
    findings,
    hasBlocker: findings.some(
      (finding) => findingSeverity(finding) === MigrationSeverity.Blocker
    ),
  };
};

export {
  MigrationSeverity,
  MigrationFinding,
  findingSeverity,
  compareVersions,
  capabilitiesInUse,
};
export type { MigrationReport };
