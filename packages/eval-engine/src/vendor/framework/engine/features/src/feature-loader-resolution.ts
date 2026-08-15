import type { FileSystem, Path, PlatformError } from "effect";

import { Effect, Option, Schema } from "effect";

import type { FeatureModuleExportDescriptor } from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import type {
  FeatureLoaderDiagnostic,
  FeatureLoaderWarning,
} from "./feature-loader-diagnostics.ts";
import type {
  DeferredFeatureModuleContribution,
  FeatureModuleNamespace,
  ResolvedContribution,
} from "./feature-loader-types.ts";
import type { ModuleLoaderError } from "../../../utils/core/src/module-loader.ts";

import {
  COMMAND_FILE_CANDIDATES,
  COMMANDS_DIR,
  FEATURE_MODULE_EXPORT_NAMES,
  FEATURE_MODULE_FILE,
  NESTED_COMMAND_ENTRY_PREFIX,
  PROMPT_FILE_CANDIDATES,
  SCHEDULE_FILE_CANDIDATES,
  SCHEDULES_DIR,
  NESTED_SCHEDULE_ENTRY_PREFIX,
} from "../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import { UnrecognizedFeatureModuleExportDiagnostic } from "./feature-loader-diagnostics.ts";
import { importFreshModule } from "../../../utils/core/src/module-loader.ts";
import { nearestName } from "../../../utils/core/src/nearest-name.ts";

interface LoaderContext {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

interface Resolved<A> {
  readonly diagnostics: readonly FeatureLoaderDiagnostic[];
  readonly value: A;
}

type ContributionResolution = "absent" | "escapes" | "present";

/** A feature's on-disk location: its directory and id, threaded together. */
interface FeatureLocation {
  readonly featureDir: string;
  readonly featureId: string;
}

type ResolveContributionFn = (
  ctx: LoaderContext,
  location: FeatureLocation,
  candidate: string
) => Effect.Effect<Resolved<ContributionResolution>>;

const FeatureModuleNamespaceSchema = Schema.Record(
  Schema.String,
  Schema.Unknown
);
const decodeFeatureModuleNamespace = Schema.decodeUnknownEffect(
  FeatureModuleNamespaceSchema
);
const decodeFeatureModuleNamespaceOption = Schema.decodeUnknownOption(
  FeatureModuleNamespaceSchema
);

// The whole-module `export default { ... } satisfies FeatureModule` form
// (formerly ORI-167) is no longer a recognized authoring shape: every
// contribution is a named export. This set is the closed vocabulary a
// default-exported plain object is checked against, so an unrelated,
// non-`FeatureModule`-shaped `export default` (e.g. a helper value) is left
// alone rather than misclassified.
const FEATURE_MODULE_DEFAULT_EXPORT_KEYS: ReadonlySet<string> = new Set<string>(
  [...FEATURE_MODULE_EXPORT_NAMES, "db", "generation"]
);

/**
 * A plain-object `default` export's own keys, but only when it is genuinely
 * shaped like the removed whole-module `FeatureModule` form: every one of its
 * own keys must be a known `feature.ts` export name (active or deferred), with
 * at least one key present. This mirrors what `satisfies FeatureModule` used
 * to enforce at compile time — old code could never carry an extra,
 * unrecognized key — so a real ORI-167-era `feature.ts` still fails loudly
 * (RFC 0002 compatibility-and-migration.md, rule
 * `feature-module-named-exports-required`), while an unrelated default
 * export that merely happens to share ONE key name with a contribution (e.g.
 * a helper object with a `generation` field alongside other, unrecognized
 * keys) is left alone rather than disabling an otherwise-valid feature.
 * A non-object default (e.g. a function) or an empty object also yields an
 * empty array.
 */
const defaultExportFeatureModuleKeys = (
  m: FeatureModuleNamespace
): readonly string[] =>
  Option.match(decodeFeatureModuleNamespaceOption(m.default), {
    onNone: () => [],
    onSome: (defaultExport) => {
      const keys = Object.keys(defaultExport);
      return keys.length > 0 &&
        keys.every((key) => FEATURE_MODULE_DEFAULT_EXPORT_KEYS.has(key))
        ? keys
        : [];
    },
  });

const importFeatureModule = (
  absolute: string
): Effect.Effect<
  FeatureModuleNamespace,
  ModuleLoaderError | PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> =>
  importFreshModule(absolute).pipe(
    Effect.flatMap(decodeFeatureModuleNamespace)
  );

const DEFERRED_FEATURE_MODULE_EXPORTS = [
  {
    entryKey: "db",
    exportName: "db",
    file: FEATURE_MODULE_FILE,
    reason:
      "authored db providers are deferred; the built-in sqlite state store remains active",
  },
  {
    entryKey: "generation",
    exportName: "generation",
    file: FEATURE_MODULE_FILE,
    reason:
      "legacy generation defaults are deferred; set the default model via the root ori.md frontmatter",
  },
] as const satisfies readonly DeferredFeatureModuleContribution[];

const featureModuleContribution = (
  module: FeatureModuleNamespace,
  descriptor: FeatureModuleExportDescriptor
): readonly ResolvedContribution[] => {
  if (!Object.hasOwn(module, descriptor.exportName)) {
    return [];
  }

  return [
    {
      entryKey: descriptor.entryKey,
      exportName: descriptor.exportName,
      file: descriptor.file,
      kind: descriptor.capability,
      moduleNamespace: module,
    },
  ];
};

const deferredFeatureModuleContribution = (
  module: FeatureModuleNamespace,
  descriptor: DeferredFeatureModuleContribution
): readonly DeferredFeatureModuleContribution[] =>
  Object.hasOwn(module, descriptor.exportName) ? [descriptor] : [];

/**
 * Discover a feature's schedule contributions (RFC 0002 schedule.md), mirroring the skill
 * `SKILL.md` + `skills/<name>/SKILL.md` pattern:
 *
 * - the feature-named schedule from a top-level `schedule.{ts,md}` file (or the
 *   `feature.ts` `schedule` export, resolved separately), and
 * - one entry per nested `schedules/<name>/schedule.{ts,md}`, named for its folder.
 *
 * Authoring two sources for the same name (e.g. both `schedule.ts` and
 * `schedule.md`, or a nested folder holding both forms) collides at registration.
 * `resolveContribution` is injected so this helper reuses the loader's
 * path-containment checks without importing back into `feature-loader`.
 */
const resolveScheduleContributions = Effect.fn(
  "FeatureLoader.resolveScheduleContributions"
)(function* (
  ctx: LoaderContext,
  location: FeatureLocation,
  resolveContribution: ResolveContributionFn
) {
  const contributions: ResolvedContribution[] = [];
  const diagnostics: FeatureLoaderDiagnostic[] = [];

  for (const file of SCHEDULE_FILE_CANDIDATES) {
    const resolved = yield* resolveContribution(ctx, location, file);
    diagnostics.push(...resolved.diagnostics);
    if (resolved.value === "present") {
      contributions.push({
        entryKey: "schedule",
        file,
        kind: "schedule",
      });
    }
  }

  const schedulesDir = ctx.path.join(location.featureDir, SCHEDULES_DIR);
  const hasSchedulesDir = yield* ctx.fs
    .exists(schedulesDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (hasSchedulesDir) {
    const names = yield* ctx.fs
      .readDirectory(schedulesDir)
      .pipe(Effect.orElseSucceed(() => []));
    for (const name of [...names].toSorted()) {
      for (const candidate of SCHEDULE_FILE_CANDIDATES) {
        const file = `${SCHEDULES_DIR}/${name}/${candidate}`;
        const resolved = yield* resolveContribution(ctx, location, file);
        diagnostics.push(...resolved.diagnostics);
        if (resolved.value === "present") {
          contributions.push({
            entryKey: `${NESTED_SCHEDULE_ENTRY_PREFIX}${name}`,
            file,
            kind: "schedule",
          });
        }
      }
    }
  }

  return {
    diagnostics,
    value: contributions,
  } satisfies Resolved<readonly ResolvedContribution[]>;
});

/**
 * Discover a feature's standalone command files (RFC 0002 command.md), mirroring
 * {@link resolveScheduleContributions} but code-only (no `.md` form):
 *
 * - the feature-named command from a top-level `command.ts` file (the `feature.ts`
 *   `command`/`commands` exports are resolved separately), and
 * - one entry per nested `commands/<name>/command.ts`, named for its folder.
 *
 * A name authored twice (e.g. a top-level `command.ts` whose contribution `name`
 * matches a `feature.ts` export, or two sources for the same `/name`) collides at
 * registration. `resolveContribution` is injected so this helper reuses the
 * loader's path-containment checks without importing back into `feature-loader`.
 */
const resolveCommandContributions = Effect.fn(
  "FeatureLoader.resolveCommandContributions"
)(function* (
  ctx: LoaderContext,
  location: FeatureLocation,
  resolveContribution: ResolveContributionFn
) {
  const contributions: ResolvedContribution[] = [];
  const diagnostics: FeatureLoaderDiagnostic[] = [];

  for (const file of COMMAND_FILE_CANDIDATES) {
    const resolved = yield* resolveContribution(ctx, location, file);
    diagnostics.push(...resolved.diagnostics);
    if (resolved.value === "present") {
      contributions.push({
        entryKey: "command",
        file,
        kind: "command",
      });
    }
  }

  const commandsDir = ctx.path.join(location.featureDir, COMMANDS_DIR);
  const hasCommandsDir = yield* ctx.fs
    .exists(commandsDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (hasCommandsDir) {
    const names = yield* ctx.fs
      .readDirectory(commandsDir)
      .pipe(Effect.orElseSucceed(() => []));
    for (const name of [...names].toSorted()) {
      for (const candidate of COMMAND_FILE_CANDIDATES) {
        const file = `${COMMANDS_DIR}/${name}/${candidate}`;
        const resolved = yield* resolveContribution(ctx, location, file);
        diagnostics.push(...resolved.diagnostics);
        if (resolved.value === "present") {
          contributions.push({
            entryKey: `${NESTED_COMMAND_ENTRY_PREFIX}${name}`,
            file,
            kind: "command",
          });
        }
      }
    }
  }

  return {
    diagnostics,
    value: contributions,
  } satisfies Resolved<readonly ResolvedContribution[]>;
});

/**
 * Discover a feature's standalone prompt module (RFC 0002 prompt.md), mirroring
 * {@link resolveCommandContributions} but with no nested directory variant: a
 * top-level `prompt.ts` carrying a named `prompt` export (the `feature.ts`
 * `prompt` export and the static `prompt.md` data file are resolved
 * separately). `resolveContribution` is injected so this helper reuses the
 * loader's path-containment checks without importing back into `feature-loader`.
 */
const resolvePromptContributions = Effect.fn(
  "FeatureLoader.resolvePromptContributions"
)(function* (
  ctx: LoaderContext,
  location: FeatureLocation,
  resolveContribution: ResolveContributionFn
) {
  const contributions: ResolvedContribution[] = [];
  const diagnostics: FeatureLoaderDiagnostic[] = [];

  for (const file of PROMPT_FILE_CANDIDATES) {
    const resolved = yield* resolveContribution(ctx, location, file);
    diagnostics.push(...resolved.diagnostics);
    if (resolved.value === "present") {
      contributions.push({
        entryKey: "prompt",
        file,
        kind: "prompt",
      });
    }
  }

  return {
    diagnostics,
    value: contributions,
  } satisfies Resolved<readonly ResolvedContribution[]>;
});

/**
 * Closed set of `feature.ts` export names the loader knows about: the recognized
 * contribution exports (RFC 0002) plus the deferred-but-known exports
 * (`db`/`generation`). Anything else is an unrecognized export — almost always a
 * typo or wrong-case name, or an unrelated `default` export the loader ignores
 * — and is ignored with a loud warning per RFC 0002 resolution-and-validation.md.
 */
const KNOWN_FEATURE_MODULE_EXPORT_NAMES: ReadonlySet<string> = new Set<string>([
  ...FEATURE_MODULE_EXPORT_NAMES,
  "db",
  "generation",
]);

/**
 * Detect `feature.ts` named exports that fall outside the closed set and turn
 * each into a non-fatal warning with a nearest-match "did you mean" suggestion.
 * `default` is excluded from the scan: an incidental `export default` that is
 * not shaped like a `FeatureModule` (caught separately by
 * {@link defaultExportFeatureModuleKeys}) is simply irrelevant to this loader,
 * not a typo warning.
 */
export const unrecognizedExportWarnings = (
  module: FeatureModuleNamespace,
  featureId: string
): readonly FeatureLoaderWarning[] =>
  Object.keys(module)
    .filter((exportName) => exportName !== "default")
    .filter((exportName) => !KNOWN_FEATURE_MODULE_EXPORT_NAMES.has(exportName))
    .map((exportName) => {
      const suggestion = nearestName(exportName, FEATURE_MODULE_EXPORT_NAMES);
      return new UnrecognizedFeatureModuleExportDiagnostic({
        exportName,
        featureId,
        suggestion,
      });
    });

export {
  defaultExportFeatureModuleKeys,
  importFeatureModule,
  DEFERRED_FEATURE_MODULE_EXPORTS,
  featureModuleContribution,
  deferredFeatureModuleContribution,
  resolveScheduleContributions,
  resolveCommandContributions,
  resolvePromptContributions,
};
export type {
  LoaderContext,
  Resolved,
  ContributionResolution,
  FeatureLocation,
  ResolveContributionFn,
};
