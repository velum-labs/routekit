import { Effect, FileSystem, Path, Result } from "effect";

import type {
  ManagedSkillPointer,
  SkillFrontmatterSchema,
} from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type {
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { ManagedSkillFetcher } from "./managed-skill-fetcher.ts";
import type { ImportedSkillContributions } from "../feature-boot/contributions.ts";

import {
  commandAliasesFromMetadata,
  decodeSkillFrontmatter,
  managedSkillPointerFromMetadata,
} from "../../../../contracts/internal/src/author-schemas/skill.ts";
import { discoverFeatures } from "../../../../engine/features/src/feature-loader.ts";
import { makeSkillRegistry } from "../../../../engine/registries/src/skill.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { resolveManagedSkill } from "./managed-skill.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";
import { parseMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";

type SkillRegistryEntry = ImportedSkillContributions["entries"][number];

interface ImportedSkillFile {
  readonly diagnostics: readonly string[];
  readonly entries: readonly SkillRegistryEntry[];
  // Degraded-but-working notes (e.g. a managed skill pointer that resolved
  // through its committed fallback body). They do not invalidate the feature.
  readonly warnings?: readonly string[];
}

interface SkillFeatureImportContext {
  readonly feature: ResolvedFeature;
  readonly featuresRoot: string;
  readonly path: Path.Path;
  readonly workspaceRoot: string;
}

interface SkillImportOptions {
  readonly managedSkillCacheRoot?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

interface ParseSkillContentInput {
  readonly feature: ResolvedFeature;
  readonly file: string;
  readonly options?: SkillImportOptions | undefined;
  readonly raw: string;
}

const buildManagedSkillFile = (input: {
  readonly body: string;
  readonly diagnostics: readonly string[];
  readonly feature: ResolvedFeature;
  readonly file: string;
  readonly merged: typeof SkillFrontmatterSchema.Type;
  readonly pointer: ManagedSkillPointer;
  readonly sourceDir: string | undefined;
  readonly warnings: readonly string[];
}): ImportedSkillFile => {
  const { description, name } = input.merged;
  if (name === undefined || description === undefined) {
    return {
      diagnostics: [
        ...input.diagnostics,
        `skill "${input.file}" for feature "${input.feature.id}": managed skill "${input.pointer.value}" did not resolve a \`name\` and \`description\` and none are committed locally`,
      ],
      entries: [],
      warnings: input.warnings,
    };
  }
  const commandAliases = commandAliasesFromMetadata(input.merged.metadata);
  const invalidAlias = commandAliases.find((alias) => alias === name);
  if (invalidAlias !== undefined) {
    return {
      diagnostics: [
        ...input.diagnostics,
        `skill "${input.file}" for feature "${input.feature.id}": command alias "${invalidAlias}" must differ from the skill name "${name}"`,
      ],
      entries: [],
      warnings: input.warnings,
    };
  }
  return {
    diagnostics: input.diagnostics,
    entries: [
      {
        ...input.merged,
        body: input.body,
        ...(commandAliases.length > 0 ? { commandAliases } : {}),
        description,
        featureId: input.feature.id,
        name,
        sourcePath: input.file,
        ...(input.sourceDir === undefined
          ? {}
          : { sourceDir: input.sourceDir }),
      },
    ],
    warnings: input.warnings,
  };
};

const importManagedSkillEntry = Effect.fn("ContributionLoader.managedSkill")(
  function* (input: {
    readonly feature: ResolvedFeature;
    readonly file: string;
    readonly frontmatter: typeof SkillFrontmatterSchema.Type;
    readonly localBody: string;
    readonly options: SkillImportOptions;
    readonly pointer: ManagedSkillPointer;
    readonly rawFrontmatter: Readonly<Record<string, unknown>>;
    readonly workspaceRoot: string;
  }) {
    const resolution = yield* resolveManagedSkill({
      cacheRoot: input.options.managedSkillCacheRoot,
      localBody: input.localBody,
      pinnedVersion: input.frontmatter.metadata?.["gateway-skill-version"],
      pointer: input.pointer,
      workspaceRoot: input.workspaceRoot,
    });
    const prefixDetail = (detail: string): string =>
      `skill "${input.file}" for feature "${input.feature.id}": ${detail}`;
    const diagnostics = resolution.diagnostics.map(prefixDetail);
    const warnings = resolution.warnings.map(prefixDetail);
    if (resolution.body === undefined) {
      return {
        diagnostics,
        entries: [],
        warnings,
      } satisfies ImportedSkillFile;
    }
    const merged = yield* decodeSkillFrontmatter({
      ...resolution.remoteFrontmatter,
      ...input.rawFrontmatter,
    }).pipe(Effect.result);
    if (Result.isFailure(merged)) {
      return {
        diagnostics: [
          ...diagnostics,
          `skill "${input.file}" for feature "${input.feature.id}" resolved frontmatter is invalid: ${String(merged.failure)}`,
        ],
        entries: [],
        warnings,
      } satisfies ImportedSkillFile;
    }
    return buildManagedSkillFile({
      body: resolution.body,
      diagnostics,
      feature: input.feature,
      file: input.file,
      merged: merged.success,
      pointer: input.pointer,
      sourceDir: resolution.sourceDir,
      warnings,
    });
  }
);

const importNativeSkillEntry = (input: {
  readonly body: string;
  readonly feature: ResolvedFeature;
  readonly file: string;
  readonly frontmatter: typeof SkillFrontmatterSchema.Type;
}): ImportedSkillFile => {
  const { description, name } = input.frontmatter;
  if (name === undefined || description === undefined) {
    return {
      diagnostics: [
        `skill "${input.file}" for feature "${input.feature.id}" frontmatter is missing the required \`name\` and \`description\` (only a managed skill pointer may omit them)`,
      ],
      entries: [],
    };
  }
  const commandAliases = commandAliasesFromMetadata(input.frontmatter.metadata);
  const invalidAlias = commandAliases.find((alias) => alias === name);
  if (invalidAlias !== undefined) {
    return {
      diagnostics: [
        `skill "${input.file}" for feature "${input.feature.id}": command alias "${invalidAlias}" must differ from the skill name "${name}"`,
      ],
      entries: [],
    };
  }
  return {
    diagnostics: [],
    entries: [
      {
        ...input.frontmatter,
        body: input.body,
        ...(commandAliases.length > 0 ? { commandAliases } : {}),
        description,
        featureId: input.feature.id,
        name,
        sourcePath: input.file,
      },
    ],
  };
};

// The workspace model is owned by the root `routekit-eval.md` alone (ROUTEKIT_EVAL-488), so a
// ported skill still declaring `model` gets a boot warning instead of a
// silent drop.
const inertFrontmatterWarnings = (
  feature: ResolvedFeature,
  file: string,
  frontmatter: Readonly<Record<string, unknown>>
): readonly string[] =>
  "model" in frontmatter
    ? [
        `skill "${file}" for feature "${feature.id}" frontmatter \`model\` is ignored: the workspace model is declared only in the root routekit-eval.md frontmatter`,
      ]
    : [];

const skillFileFailure = (
  feature: ResolvedFeature,
  file: string,
  details: readonly string[]
): ImportedSkillFile => ({
  diagnostics: details.map(
    (detail) => `skill "${file}" for feature "${feature.id}" ${detail}`
  ),
  entries: [],
});

const parseSkillContent = Effect.fn("ContributionLoader.parseSkillContent")(
  function* (input: ParseSkillContentInput) {
    const { feature, file, options, raw } = input;
    const parsed = yield* parseMarkdownFrontmatter(raw);
    if (!parsed.hasFrontmatter) {
      return skillFileFailure(feature, file, [
        "is missing required frontmatter",
      ]);
    }

    const frontmatter = yield* decodeSkillFrontmatter(parsed.frontmatter).pipe(
      Effect.result
    );

    if (Result.isFailure(frontmatter)) {
      return skillFileFailure(feature, file, [
        ...parsed.diagnostics,
        `frontmatter is invalid: ${String(frontmatter.failure)}`,
      ]);
    }

    if (parsed.diagnostics.length > 0) {
      return skillFileFailure(feature, file, parsed.diagnostics);
    }

    const warnings = inertFrontmatterWarnings(
      feature,
      file,
      parsed.frontmatter
    );

    const pointer = managedSkillPointerFromMetadata(
      frontmatter.success.metadata
    );
    if (pointer !== undefined && options?.workspaceRoot !== undefined) {
      const managed = yield* importManagedSkillEntry({
        feature,
        file,
        frontmatter: frontmatter.success,
        localBody: parsed.body,
        options,
        pointer,
        rawFrontmatter: parsed.frontmatter,
        workspaceRoot: options.workspaceRoot,
      });
      return {
        ...managed,
        warnings: [...warnings, ...(managed.warnings ?? [])],
      } satisfies ImportedSkillFile;
    }

    return {
      ...importNativeSkillEntry({
        body: parsed.body,
        feature,
        file,
        frontmatter: frontmatter.success,
      }),
      warnings,
    } satisfies ImportedSkillFile;
  }
);

const emptySkillFileResult = (diagnostic: string): ImportedSkillFile => ({
  diagnostics: [diagnostic],
  entries: [],
});

interface ImportSkillFileInput {
  readonly absolutePath: string;
  readonly feature: ResolvedFeature;
  readonly file: string;
  readonly options?: SkillImportOptions | undefined;
}

const importSkillFile = Effect.fn("ContributionLoader.skillFile")(function* (
  input: ImportSkillFileInput
) {
  const fs = yield* FileSystem.FileSystem;
  const imported = yield* fs
    .readFileString(input.absolutePath)
    .pipe(Effect.result);

  if (Result.isFailure(imported)) {
    return emptySkillFileResult(
      `could not read skill for feature "${input.feature.id}": ${formatUnknownError(imported.failure)}`
    );
  }

  return yield* parseSkillContent({
    feature: input.feature,
    file: input.file,
    options: input.options,
    raw: imported.success,
  });
});

const importSkillContribution = (
  context: SkillFeatureImportContext,
  contribution: ResolvedContribution
): Effect.Effect<
  Omit<ImportedSkillContributions, "registry">,
  never,
  FileSystem.FileSystem | Path.Path | ManagedSkillFetcher
> => {
  const absolute = makeContributionSourcePath({
    contribution,
    feature: context.feature,
    featuresRoot: context.featuresRoot,
    joinPath: context.path.join,
  });

  return importSkillFile({
    absolutePath: absolute,
    feature: context.feature,
    file: contribution.file,
    options: { workspaceRoot: context.workspaceRoot },
  }).pipe(
    Effect.map(
      (
        result: ImportedSkillFile
      ): Omit<ImportedSkillContributions, "registry"> =>
        makeProjectContributionSet({
          diagnostics: result.diagnostics,
          entries: result.entries,
          feature: context.feature,
          kind: "skill",
          sourcePath: absolute,
          warnings: result.warnings ?? [],
        })
    )
  );
};

const importFeatureSkillContributions = Effect.fn(
  "ContributionLoader.featureSkills"
)(function* (context: SkillFeatureImportContext) {
  if (!context.feature.valid) {
    return disabledFeatureContributionSet<SkillRegistryEntry>(
      "skill",
      context.feature
    );
  }

  return combineContributionSets(
    yield* Effect.all(
      context.feature.contributions
        .filter((contribution) => contribution.kind === "skill")
        .map((contribution) => importSkillContribution(context, contribution))
    )
  );
});

export const importSkillContributionsFromFeatures = Effect.fn(
  "ContributionLoader.skillsFromFeatures"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;
  // Managed skill pointers resolve against the workspace root (the directory
  // holding `.routekit-eval/`), which by convention is the features root's parent.
  const workspaceRoot = path.dirname(path.resolve(featuresRoot));
  const imported = combineContributionSets(
    yield* Effect.all(
      features.map((feature) =>
        importFeatureSkillContributions({
          feature,
          featuresRoot,
          path,
          workspaceRoot,
        })
      )
    )
  );
  return {
    ...imported,
    registry: makeSkillRegistry(imported.entries),
  } satisfies ImportedSkillContributions;
});
export const importSkillContributions = Effect.fn("ContributionLoader.skills")(
  function* (featuresRoot: string) {
    const { features } = yield* discoverFeatures(featuresRoot);
    return yield* importSkillContributionsFromFeatures(featuresRoot, features);
  }
);
export { importSkillFile };
