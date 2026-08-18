import { Effect, FileSystem, Option, Path, Result } from "effect";

import type { ScheduleDefinition } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type {
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";
import type { ImportedNamedContributions } from "../feature-boot/contributions.ts";

import {
  decodeScheduleDefinition,
  decodeScheduleFrontmatter,
} from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import { NESTED_SCHEDULE_ENTRY_PREFIX } from "../../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { parseMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";
import { importFreshNamedExport } from "../../../../utils/core/src/module-loader.ts";

type ScheduleEntry =
  ImportedNamedContributions<ScheduleDefinition>["entries"][number];

interface ImportedScheduleFile {
  readonly diagnostics: readonly string[];
  readonly entries: readonly ScheduleEntry[];
}

interface ScheduleFeatureImportContext {
  readonly feature: ResolvedFeature;
  readonly featuresRoot: string;
  readonly path: Path.Path;
}

/** Entry-key prefix for nested `schedules/<name>/schedule.{ts,md}` contributions (RFC 0002 schedule.md). */

/**
 * The registry name for a schedule contribution: the feature id for the
 * feature-named schedule (root `schedule.{ts,md}` or the `feature.ts` `schedule`
 * export), or the nested folder name for a `schedules/<name>/schedule.{ts,md}`
 * entry, mirroring nested skills (RFC 0002 schedule.md).
 */
const scheduleName = (
  feature: ResolvedFeature,
  contribution: ResolvedContribution
): string =>
  contribution.entryKey.startsWith(NESTED_SCHEDULE_ENTRY_PREFIX)
    ? contribution.entryKey.slice(NESTED_SCHEDULE_ENTRY_PREFIX.length)
    : feature.id;

const singleScheduleEntry = (
  feature: ResolvedFeature,
  name: string,
  value: ScheduleDefinition
): ImportedScheduleFile => ({
  diagnostics: [],
  entries: [
    {
      featureId: feature.id,
      name,
      value,
    },
  ],
});

const emptyScheduleFileResult = (diagnostic: string): ImportedScheduleFile => ({
  diagnostics: [diagnostic],
  entries: [],
});

const importScheduleExport = Effect.fn("ContributionLoader.scheduleExport")(
  function* (feature: ResolvedFeature, value: unknown, name: string) {
    const decoded = yield* decodeScheduleDefinition(value).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      return emptyScheduleFileResult(
        `schedule for feature "${feature.id}" is invalid: ${String(decoded.failure)}`
      );
    }
    return singleScheduleEntry(feature, name, decoded.success);
  }
);

const importScheduleModuleFile = Effect.fn(
  "ContributionLoader.scheduleModuleFile"
)(function* (feature: ResolvedFeature, absolute: string, name: string) {
  const imported = yield* importFreshNamedExport(absolute, "schedule").pipe(
    Effect.option
  );
  if (Option.isNone(imported)) {
    return emptyScheduleFileResult(
      `could not import schedule "${name}" for feature "${feature.id}"`
    );
  }

  // A standalone `schedule.{ts}` must expose the schedule as the named `schedule`
  // export — never a default export — mirroring the `api` contribution
  // (RFC 0002 schedule.md). `importFreshNamedExport` returns `undefined` when the module
  // has no `schedule` export, so surface a precise, actionable diagnostic rather
  // than a downstream decode failure on `undefined`.
  if (imported.value === undefined) {
    return emptyScheduleFileResult(
      `schedule "${name}" for feature "${feature.id}" must export a named "schedule" (e.g. \`export const schedule = defineSchedule(...)\`), not a default export`
    );
  }

  const decoded = yield* decodeScheduleDefinition(imported.value).pipe(
    Effect.result
  );
  if (Result.isFailure(decoded)) {
    return emptyScheduleFileResult(
      `schedule "${name}" for feature "${feature.id}" is invalid: ${String(decoded.failure)}`
    );
  }

  return singleScheduleEntry(feature, name, decoded.success);
});

const importScheduleMarkdownFile = Effect.fn(
  "ContributionLoader.scheduleMarkdownFile"
)(function* (feature: ResolvedFeature, absolute: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const imported = yield* fs.readFileString(absolute).pipe(Effect.option);
  if (Option.isNone(imported)) {
    return emptyScheduleFileResult(
      `could not read schedule "${name}" for feature "${feature.id}"`
    );
  }

  const parsed = yield* parseMarkdownFrontmatter(imported.value);
  if (!parsed.hasFrontmatter) {
    return emptyScheduleFileResult(
      `schedule "${name}" for feature "${feature.id}" is missing required frontmatter`
    );
  }

  // Reject malformed frontmatter (unterminated block, non key/value lines, duplicate keys) before decoding: these are
  // structural parse errors, so trusting the decoded values — or surfacing a downstream decode/body error instead of
  // the precise diagnostic — would be misleading.
  if (parsed.diagnostics.length > 0) {
    return {
      diagnostics: parsed.diagnostics.map(
        (detail) => `schedule "${name}" for feature "${feature.id}" ${detail}`
      ),
      entries: [],
    } satisfies ImportedScheduleFile;
  }

  const frontmatter = yield* decodeScheduleFrontmatter(parsed.frontmatter).pipe(
    Effect.result
  );
  if (Result.isFailure(frontmatter)) {
    return emptyScheduleFileResult(
      `schedule "${name}" for feature "${feature.id}" frontmatter is invalid: ${String(frontmatter.failure)}`
    );
  }

  const markdown = parsed.body.trim();
  if (markdown.length === 0) {
    return emptyScheduleFileResult(
      `schedule "${name}" for feature "${feature.id}" has an empty markdown body`
    );
  }

  return singleScheduleEntry(feature, name, {
    catchUp: frontmatter.success.catchUp,
    cron: frontmatter.success.cron,
    markdown,
    disabled: frontmatter.success.disabled,
    jitterMs: frontmatter.success.jitterMs,
    overlap: frontmatter.success.overlap,
    timezone: frontmatter.success.timezone,
  });
});

const importScheduleSource = (
  feature: ResolvedFeature,
  source: {
    readonly contribution: ResolvedContribution;
    readonly absolute: string;
  },
  name: string
): Effect.Effect<
  ImportedScheduleFile,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const { contribution, absolute } = source;
  if (
    contribution.exportName !== undefined &&
    contribution.moduleNamespace !== undefined
  ) {
    return importScheduleExport(
      feature,
      contribution.moduleNamespace[contribution.exportName],
      name
    );
  }
  return contribution.file.endsWith(".md")
    ? importScheduleMarkdownFile(feature, absolute, name)
    : importScheduleModuleFile(feature, absolute, name);
};

const importScheduleContribution = (
  context: ScheduleFeatureImportContext,
  contribution: ResolvedContribution
): Effect.Effect<
  ImportedNamedContributions<ScheduleDefinition>,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const absolute = makeContributionSourcePath({
    contribution,
    feature: context.feature,
    featuresRoot: context.featuresRoot,
    joinPath: context.path.join,
  });
  const name = scheduleName(context.feature, contribution);

  return importScheduleSource(
    context.feature,
    {
      absolute,
      contribution,
    },
    name
  ).pipe(
    Effect.map(
      (result): ImportedNamedContributions<ScheduleDefinition> =>
        makeProjectContributionSet({
          diagnostics: result.diagnostics,
          entries: result.entries,
          feature: context.feature,
          kind: "schedule",
          sourcePath: absolute,
        })
    )
  );
};

const importFeatureScheduleContributions = Effect.fn(
  "ContributionLoader.featureSchedules"
)(function* (context: ScheduleFeatureImportContext) {
  if (!context.feature.valid) {
    return disabledFeatureContributionSet<
      NamedContributionEntry<ScheduleDefinition>
    >("schedule", context.feature);
  }

  return combineContributionSets(
    yield* Effect.all(
      context.feature.contributions
        .filter((contribution) => contribution.kind === "schedule")
        .map((contribution) =>
          importScheduleContribution(context, contribution)
        )
    )
  );
});

export const importScheduleContributionsFromFeatures = Effect.fn(
  "ContributionLoader.schedulesFromFeatures"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;
  return combineContributionSets(
    yield* Effect.all(
      features.map((feature) =>
        importFeatureScheduleContributions({
          feature,
          featuresRoot,
          path,
        })
      )
    )
  );
});

export { importScheduleMarkdownFile };
