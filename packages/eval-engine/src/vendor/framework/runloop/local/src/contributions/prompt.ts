import { Effect, FileSystem, Path, Result } from "effect";

import type { PromptRegistryEntry } from "../../../../contracts/internal/src/author-schemas/prompt.ts";
import type {
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { ImportedPromptContributions } from "../feature-boot/contributions.ts";
import type { FreshModule } from "../../../../utils/core/src/module-loader.ts";

import {
  decodePromptFrontmatter,
  decodePromptModuleMetadata,
  decodePromptProviderShape,
} from "../../../../contracts/internal/src/author-schemas/prompt.ts";
import { adaptPromptProvider } from "../../../../engine/registries/src/prompt.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";
import { parseMarkdownFrontmatter } from "../../../../utils/core/src/markdown-frontmatter.ts";
import {
  decodeDefaultExportValues,
  importFreshModule,
} from "../../../../utils/core/src/module-loader.ts";

interface ImportedPromptFile {
  readonly diagnostics: readonly string[];
  readonly entries: readonly PromptRegistryEntry[];
}

interface PromptFeatureImportInput {
  readonly feature: ResolvedFeature;
  readonly featuresRoot: string;
  readonly path: Path.Path;
}

const importPromptMarkdownContent = Effect.fn(
  "ContributionLoader.promptMarkdownContent"
)(function* (feature: ResolvedFeature, content: string) {
  const parsed = yield* parseMarkdownFrontmatter(content);

  const metadata = yield* decodePromptFrontmatter(parsed.frontmatter).pipe(
    Effect.result
  );
  if (Result.isFailure(metadata)) {
    const diagnostics = [
      ...parsed.diagnostics,
      `frontmatter is invalid: ${String(metadata.failure)}`,
    ];
    return {
      diagnostics: diagnostics.map(
        (detail) => `prompt for feature "${feature.id}" ${detail}`
      ),
      entries: [],
    } satisfies ImportedPromptFile;
  }

  if (parsed.diagnostics.length > 0) {
    return {
      diagnostics: parsed.diagnostics.map(
        (detail) => `prompt for feature "${feature.id}" ${detail}`
      ),
      entries: [],
    } satisfies ImportedPromptFile;
  }

  return {
    diagnostics: [],
    entries: [
      {
        name: metadata.success.name ?? feature.id,
        order: metadata.success.order ?? 0,
        section: metadata.success.section,
        text: parsed.body,
        type: "static",
      },
    ],
  } satisfies ImportedPromptFile;
});

interface DynamicPromptEntryOptions {
  readonly baseName: string;
  readonly order: number;
}

const buildDynamicPromptEntries = Effect.fn(
  "ContributionLoader.dynamicPromptEntries"
)(function* (
  feature: ResolvedFeature,
  values: readonly unknown[],
  options: DynamicPromptEntryOptions
) {
  const { baseName, order } = options;
  const entries: PromptRegistryEntry[] = [];
  const diagnostics: string[] = [];
  for (const [index, value] of values.entries()) {
    const decoded = yield* decodePromptProviderShape(value).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      diagnostics.push(
        `prompt export for feature "${feature.id}" is not a valid PromptProvider: ${formatUnknownError(decoded.failure)}`
      );
      continue;
    }
    entries.push({
      name: values.length === 1 ? baseName : `${baseName}/${index + 1}`,
      order,
      provider: adaptPromptProvider(decoded.success),
      type: "dynamic",
    });
  }

  return {
    diagnostics,
    entries,
  } satisfies ImportedPromptFile;
});

const emptyPromptFileResult = (diagnostic: string): ImportedPromptFile => ({
  diagnostics: [diagnostic],
  entries: [],
});

const importPromptMarkdownFile = Effect.fn(
  "ContributionLoader.promptMarkdownFile"
)(function* (feature: ResolvedFeature, absolute: string) {
  const fs = yield* FileSystem.FileSystem;
  const imported = yield* fs.readFileString(absolute).pipe(Effect.result);

  if (Result.isFailure(imported)) {
    return emptyPromptFileResult(
      `could not read prompt for feature "${feature.id}": ${formatUnknownError(imported.failure)}`
    );
  }

  return yield* importPromptMarkdownContent(feature, imported.success);
});

const importPromptExport = Effect.fn("ContributionLoader.promptExport")(
  function* (feature: ResolvedFeature, value: unknown) {
    const decodedValues = yield* decodeDefaultExportValues(value).pipe(
      Effect.result
    );

    if (Result.isFailure(decodedValues)) {
      return emptyPromptFileResult(
        `could not import prompt for feature "${feature.id}": ${formatUnknownError(decodedValues.failure)}`
      );
    }

    return yield* buildDynamicPromptEntries(feature, decodedValues.success, {
      baseName: feature.id,
      order: 0,
    });
  }
);

const importPromptModule = Effect.fn("ContributionLoader.promptModule")(
  function* (feature: ResolvedFeature, module: FreshModule) {
    if (!Object.hasOwn(module, "prompt")) {
      return emptyPromptFileResult(
        `prompt module for feature "${feature.id}" has no named "prompt" export`
      );
    }

    const decodedValues = yield* decodeDefaultExportValues(module.prompt).pipe(
      Effect.result
    );

    // Read the optional `order`/`name` named exports so a dynamic `prompt.ts` can
    // declare its entry-level position the same way a static `prompt.md` does via
    // frontmatter. Invalid metadata is a diagnostic, not a silent fallback.
    const metadata = yield* decodePromptModuleMetadata({
      name: module.name,
      order: module.order,
    }).pipe(Effect.result);

    if (Result.isFailure(decodedValues)) {
      return emptyPromptFileResult(
        `could not import prompt for feature "${feature.id}": ${formatUnknownError(decodedValues.failure)}`
      );
    }

    if (Result.isFailure(metadata)) {
      return {
        diagnostics: [
          `prompt module for feature "${feature.id}" has invalid "name"/"order" exports: ${formatUnknownError(metadata.failure)}`,
        ],
        entries: [],
      } satisfies ImportedPromptFile;
    }

    return yield* buildDynamicPromptEntries(feature, decodedValues.success, {
      baseName: metadata.success.name ?? feature.id,
      order: metadata.success.order ?? 0,
    });
  }
);

const importPromptModuleFile = Effect.fn("ContributionLoader.promptModuleFile")(
  function* (feature: ResolvedFeature, absolute: string) {
    const module = yield* importFreshModule(absolute).pipe(Effect.result);

    if (Result.isFailure(module)) {
      return emptyPromptFileResult(
        `could not import prompt for feature "${feature.id}": ${formatUnknownError(module.failure)}`
      );
    }

    return yield* importPromptModule(feature, module.success);
  }
);

const importPromptFile = Effect.fn("ContributionLoader.promptFile")(function* (
  feature: ResolvedFeature,
  absolute: string,
  file: string
) {
  return file.endsWith(".md")
    ? yield* importPromptMarkdownFile(feature, absolute)
    : yield* importPromptModuleFile(feature, absolute);
});

const importPromptContribution = (
  input: PromptFeatureImportInput,
  contribution: ResolvedContribution
): Effect.Effect<
  ImportedPromptContributions,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const absolute = makeContributionSourcePath({
    contribution,
    feature: input.feature,
    featuresRoot: input.featuresRoot,
    joinPath: input.path.join,
  });

  const imported =
    contribution.exportName !== undefined &&
    contribution.moduleNamespace !== undefined
      ? importPromptExport(
          input.feature,
          contribution.moduleNamespace[contribution.exportName]
        )
      : importPromptFile(input.feature, absolute, contribution.file);

  return imported.pipe(
    Effect.map(
      (result): ImportedPromptContributions =>
        makeProjectContributionSet({
          diagnostics: result.diagnostics,
          entries: result.entries,
          feature: input.feature,
          kind: "prompt",
          sourcePath: absolute,
        })
    )
  );
};

const importFeaturePromptContributions = (
  input: PromptFeatureImportInput
): Effect.Effect<
  ImportedPromptContributions,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  if (!input.feature.valid) {
    return Effect.succeed(
      disabledFeatureContributionSet("prompt", input.feature)
    );
  }

  return Effect.all(
    input.feature.contributions
      .filter((contribution) => contribution.kind === "prompt")
      .map((contribution) => importPromptContribution(input, contribution))
  ).pipe(Effect.map(combineContributionSets));
};

export const importPromptContributionsFromFeatures = Effect.fn(
  "ContributionLoader.promptFromFeatures"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;

  return combineContributionSets(
    yield* Effect.all(
      features.map((feature) =>
        importFeaturePromptContributions({
          feature,
          featuresRoot,
          path,
        })
      )
    )
  );
});

export { importPromptFile };
