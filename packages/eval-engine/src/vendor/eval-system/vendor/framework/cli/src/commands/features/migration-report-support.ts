import { Effect, FileSystem, Option, Path, Result } from "effect";

import type { FeatureDefinition } from "../../../../runloop/local/src/feature-boot/types.ts";
import type {
  MigrationFinding,
  MigrationReport,
} from "../../../../runloop/local/src/migration/migration-report.ts";

import { decodeRootPersonaFrontmatter } from "../../../../contracts/internal/src/author-schemas/root-persona.ts";
import {
  formatError,
  formatWarning,
} from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { ROOT_PERSONA_FILE } from "../../../../runloop/local/src/contributions/root-persona.ts";
import {
  buildMigrationReport,
  capabilitiesInUse,
  MigrationFinding as MigrationFindingEnum,
} from "../../../../runloop/local/src/migration/migration-report.ts";
import { readVersionInfo } from "../version/version-info.ts";
import {
  parseMarkdownFrontmatter,
  upsertMarkdownFrontmatter,
} from "../../../../utils/core/src/markdown-frontmatter.ts";

/**
 * Read the generating CLI version a workspace recorded in its `routekit-eval.md`
 * frontmatter `version` stamp (written by `routekit-eval init`, RFC 0002). Returns
 * `undefined` when there is no `routekit-eval.md`, no `version` key, or the frontmatter
 * does not decode — the migration report treats an absent version as "cannot
 * prove a rule post-dates this workspace" rather than an error.
 *
 * `workspaceRoot` is the directory that holds `routekit-eval.md` — the parent of
 * `features/`, not the features root itself.
 */
const readWorkspaceVersion = Effect.fn("MigrationReport.readWorkspaceVersion")(
  function* (workspaceRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const personaPath = path.join(workspaceRoot, ROOT_PERSONA_FILE);

    const content = yield* fs.readFileString(personaPath).pipe(Effect.option);
    if (Option.isNone(content)) {
      return;
    }

    const parsed = yield* parseMarkdownFrontmatter(content.value);
    const decoded = yield* decodeRootPersonaFrontmatter(
      parsed.frontmatter
    ).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      return;
    }
    return decoded.success.version ?? undefined;
  }
);

/**
 * Build the migration report for a resolved workspace (RFC 0002): correlate the
 * live loader diagnostics with the version gap between the workspace's `routekit-eval.md`
 * `version` stamp and the running CLI. `featuresRoot` is the `features/` dir;
 * the `routekit-eval.md` stamp lives in its parent (the workspace root).
 *
 * `runningVersion` defaults to the in-process CLI version (`readVersionInfo`),
 * which is correct for `routekit-eval features validate` — that command runs entirely on
 * the binary producing the report. `routekit-eval update` MUST pass an explicit override:
 * after the binary is installed the *current process is still the old binary*,
 * so its in-process `readVersionInfo` is stale; the report and baseline-advance
 * must be computed against the newly-installed version read from disk.
 *
 * Owning this here keeps the command layer thin and the engine/version-info
 * dependencies out of `features/command.ts`.
 */
const buildValidationMigrationReport = Effect.fn(
  "MigrationReport.buildValidation"
)(function* (
  featuresRoot: string,
  definition: FeatureDefinition,
  runningVersionOverride?: string
) {
  const path = yield* Path.Path;
  const generatedWithVersion = yield* readWorkspaceVersion(
    path.dirname(featuresRoot)
  );
  const runningVersion =
    runningVersionOverride ?? (yield* readVersionInfo).version;
  return buildMigrationReport({
    diagnostics: definition.structuredDiagnostics,
    capabilitiesInUse: capabilitiesInUse(definition),
    generatedWithVersion,
    runningVersion,
  });
});

/**
 * Advance the workspace baseline (RFC 0002): rewrite the `routekit-eval.md` frontmatter
 * `version` stamp to `toVersion`, the running CLI's version. `upsertMarkdownFrontmatter`
 * rewrites the field in place — preserving the rest of the frontmatter and the
 * persona body — and synthesizes a frontmatter block if somehow absent.
 *
 * Callers MUST only advance after a report with **no blockers** (RFC line 116):
 * when a blocker is present the baseline must NOT move, so the next run
 * re-reports until the author migrates. A missing `routekit-eval.md` is a no-op — there is
 * no persona to stamp, and `validate`/`update` already surface that separately.
 *
 * `workspaceRoot` is the directory that holds `routekit-eval.md` (the parent of `features/`).
 */
const advanceWorkspaceBaseline = Effect.fn("MigrationReport.advanceBaseline")(
  function* (workspaceRoot: string, toVersion: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const personaPath = path.join(workspaceRoot, ROOT_PERSONA_FILE);

    const existing = yield* fs.readFileString(personaPath).pipe(Effect.option);
    if (Option.isNone(existing)) {
      return false;
    }

    const updated = upsertMarkdownFrontmatter(existing.value, {
      version: toVersion,
    });
    yield* fs.writeFileString(personaPath, updated);
    return true;
  }
);

/**
 * A one-line human label for a finding, with the source-file/feature context
 * the loader supplied. Exhaustive via `$match`, so a new finding variant is a
 * compile error here rather than a silently-unformatted finding.
 */
const formatFindingLine = (finding: MigrationFinding): string =>
  MigrationFindingEnum.$match(finding, {
    RemovedCapability: (value) => value.message,
    DeprecatedCapability: (value) => value.message,
    BreakingShapeChange: (value) => {
      const location = value.file ?? value.featureId;
      return location === undefined
        ? value.message
        : `${value.message}\n    File: ${location}`;
    },
    LoaderDiagnostic: (value) => {
      const location = value.file ?? value.featureId;
      return location === undefined
        ? value.message
        : `${value.message}\n    File: ${location}`;
    },
  });

/**
 * The lines a migration report contributes to human (`stderr`) output, each
 * already glyph-prefixed by severity.
 *
 * `includeLoaderDiagnostics` controls whether plain `LoaderDiagnostic` findings
 * (the loader's own message verbatim) are rendered:
 *   - `routekit-eval features validate` passes `false` (the default): it already prints
 *     every loader diagnostic from its raw `structuredDiagnostics` loop, so
 *     including them here would double-print. It then surfaces only the
 *     **version-context** findings — removed/deprecated capabilities and the
 *     `BreakingShapeChange` sniffer case.
 *   - `routekit-eval update` passes `true`: it has no separate raw-diagnostics loop, so
 *     this is the *only* place the report is printed. A plain `LoaderDiagnostic`
 *     blocker would otherwise drive a non-zero exit with nothing on screen
 *     explaining why. Including them keeps the report self-contained.
 *
 * The full set (including `LoaderDiagnostic`) is always exposed via
 * `migrationReportJson` for machine consumers regardless of this flag. Returns
 * an empty array when there is nothing to add.
 */
export const formatMigrationReportLines = (
  report: MigrationReport,
  includeLoaderDiagnostics = false
): readonly string[] =>
  report.findings.flatMap((finding) =>
    MigrationFindingEnum.$match(finding, {
      RemovedCapability: () => [formatError(formatFindingLine(finding))],
      DeprecatedCapability: () => [formatWarning(formatFindingLine(finding))],
      BreakingShapeChange: () => [formatError(formatFindingLine(finding))],
      LoaderDiagnostic: () =>
        includeLoaderDiagnostics
          ? [formatError(formatFindingLine(finding))]
          : [],
    })
  );

/**
 * The JSON shape for a finding in the machine envelope — the tag plus the
 * fields a tool would key off. Flattened from the tagged union so consumers do
 * not need to know the `Data.TaggedEnum` runtime representation.
 */
export const migrationFindingJson = (
  finding: MigrationFinding
): {
  readonly kind: string;
  readonly capability?: string | undefined;
  readonly featureId?: string | undefined;
  readonly file?: string | undefined;
  readonly rule?: string | undefined;
  readonly introducedIn?: string | undefined;
  readonly message: string;
} =>
  MigrationFindingEnum.$match(finding, {
    RemovedCapability: (value) => ({
      kind: value._tag,
      capability: value.capability,
      introducedIn: value.removedIn,
      message: value.message,
    }),
    DeprecatedCapability: (value) => ({
      kind: value._tag,
      capability: value.capability,
      introducedIn: value.deprecatedIn,
      message: value.message,
    }),
    BreakingShapeChange: (value) => ({
      kind: value._tag,
      capability: value.capability,
      featureId: value.featureId,
      file: value.file,
      rule: value.rule,
      introducedIn: value.introducedIn,
      message: value.message,
    }),
    LoaderDiagnostic: (value) => ({
      kind: value._tag,
      capability: value.capability,
      featureId: value.featureId,
      file: value.file,
      message: value.message,
    }),
  });

/** The migration report as a plain JSON object for the `--json` envelope. */
export const migrationReportJson = (
  report: MigrationReport
): {
  readonly generatedWithVersion: string | null;
  readonly runningVersion: string;
  readonly hasBlocker: boolean;
  readonly findings: readonly ReturnType<typeof migrationFindingJson>[];
} => ({
  generatedWithVersion: report.generatedWithVersion ?? null,
  runningVersion: report.runningVersion,
  hasBlocker: report.hasBlocker,
  findings: report.findings.map((finding) => migrationFindingJson(finding)),
});

export {
  readWorkspaceVersion,
  buildValidationMigrationReport,
  advanceWorkspaceBaseline,
};
