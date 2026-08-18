import type { FileSystem, PlatformError, Schema } from "effect";

import { Effect, Path, Result } from "effect";

import type { ApiRegistryEntry } from "../../../../contracts/internal/src/author-schemas/api.ts";
import type {
  FeatureModuleNamespace,
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { ImportedApiContributions } from "../feature-boot/contributions.ts";
import type { ModuleLoaderError } from "../../../../utils/core/src/module-loader.ts";

import { decodeApiContribution } from "../../../../contracts/internal/src/author-schemas/api.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";
import { importFreshNamedExport } from "../../../../utils/core/src/module-loader.ts";

interface ImportedApiFile {
  readonly diagnostics: readonly string[];
  readonly entries: readonly ApiRegistryEntry[];
}

interface ApiFeatureImportInput {
  readonly feature: ResolvedFeature;
  readonly featuresRoot: string;
  readonly path: Path.Path;
}

const importApiExport = (
  absolute: string,
  moduleNamespace: FeatureModuleNamespace | undefined
): Effect.Effect<
  unknown,
  ModuleLoaderError | PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> => {
  if (moduleNamespace !== undefined) {
    return Effect.succeed(moduleNamespace.api);
  }

  return importFreshNamedExport(absolute, "api");
};

const importApiValue = Effect.fn("ContributionLoader.apiValue")(function* (
  feature: ResolvedFeature,
  value: unknown
) {
  const decoded = yield* decodeApiContribution(value).pipe(Effect.result);

  if (Result.isFailure(decoded)) {
    return {
      diagnostics: [
        `api export for feature "${feature.id}" is not a valid ApiContribution: ${formatUnknownError(decoded.failure)}`,
      ],
      entries: [],
    } satisfies ImportedApiFile;
  }

  return {
    diagnostics: [],
    entries: [
      {
        api: decoded.success,
        featureId: feature.id,
      },
    ],
  } satisfies ImportedApiFile;
});

const emptyApiFileResult = (diagnostic: string): ImportedApiFile => ({
  diagnostics: [diagnostic],
  entries: [],
});

const importApiFile = Effect.fn("ContributionLoader.apiFile")(function* (
  feature: ResolvedFeature,
  absolute: string,
  moduleNamespace?: FeatureModuleNamespace
) {
  const imported = yield* importApiExport(absolute, moduleNamespace).pipe(
    Effect.result
  );

  if (Result.isFailure(imported)) {
    return emptyApiFileResult(
      `could not import api for feature "${feature.id}": ${formatUnknownError(imported.failure)}`
    );
  }

  if (imported.success === undefined) {
    return {
      diagnostics: [],
      entries: [],
    } satisfies ImportedApiFile;
  }

  return yield* importApiValue(feature, imported.success);
});

const importApiContribution = (
  input: ApiFeatureImportInput,
  contribution: ResolvedContribution
): Effect.Effect<
  ImportedApiContributions,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const absolute = makeContributionSourcePath({
    contribution,
    feature: input.feature,
    featuresRoot: input.featuresRoot,
    joinPath: input.path.join,
  });

  return importApiFile(
    input.feature,
    absolute,
    contribution.moduleNamespace
  ).pipe(
    Effect.map(
      (result): ImportedApiContributions =>
        makeProjectContributionSet({
          diagnostics: result.diagnostics,
          entries: result.entries,
          feature: input.feature,
          kind: "api",
          sourcePath: absolute,
        })
    )
  );
};

const importFeatureApiContributions = (
  input: ApiFeatureImportInput
): Effect.Effect<
  ImportedApiContributions,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  if (!input.feature.valid) {
    return Effect.succeed(disabledFeatureContributionSet("api", input.feature));
  }

  return Effect.all(
    input.feature.contributions
      .filter((contribution) => contribution.entryKey === "api")
      .map((contribution) => importApiContribution(input, contribution))
  ).pipe(Effect.map(combineContributionSets));
};

export const importApiContributionsFromFeatures = Effect.fn(
  "ContributionLoader.apiFromFeatures"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;

  return combineContributionSets(
    yield* Effect.all(
      features.map((feature) =>
        importFeatureApiContributions({
          feature,
          featuresRoot,
          path,
        })
      )
    )
  );
});

export { importApiFile };
