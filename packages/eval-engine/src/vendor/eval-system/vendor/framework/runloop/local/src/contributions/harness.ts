import type { FileSystem, PlatformError, Schema } from "effect";

import { Effect, Path, Result } from "effect";

import type {
  FeatureModuleNamespace,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { ImportedHarnesses } from "../feature-boot/contributions.ts";
import type { ModuleLoaderError } from "../../../../utils/core/src/module-loader.ts";

import { discoverFeatures } from "../../../../engine/features/src/feature-loader.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { makeRuntimeHarnessFromContribution } from "../harness/contribution-runtime.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";
import {
  decodeDefaultExportValues,
  importFreshDefaultExport,
  importFreshNamedExport,
} from "../../../../utils/core/src/module-loader.ts";

interface ImportedHarnessFile {
  readonly diagnostics: readonly string[];
  readonly entries: readonly RuntimeHarness[];
}

const importHarnessExport = (
  absolute: string,
  exportName: string | undefined,
  moduleNamespace: FeatureModuleNamespace | undefined
): Effect.Effect<
  unknown,
  ModuleLoaderError | PlatformError.PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> => {
  if (exportName !== undefined && moduleNamespace !== undefined) {
    return Effect.succeed(moduleNamespace[exportName]);
  }

  return exportName === undefined
    ? importFreshDefaultExport(absolute)
    : importFreshNamedExport(absolute, exportName);
};

const importHarnessValues = Effect.fn("ContributionLoader.harnessValues")(
  function* (feature: ResolvedFeature, imported: unknown) {
    const values = yield* decodeDefaultExportValues(imported);
    const entries: RuntimeHarness[] = [];
    const diagnostics: string[] = [];
    for (const value of values) {
      const runtimeHarness = yield* makeRuntimeHarnessFromContribution(
        value
      ).pipe(Effect.result);
      if (Result.isFailure(runtimeHarness)) {
        diagnostics.push(
          `harness export for feature "${feature.id}" failed registration: ${formatUnknownError(runtimeHarness.failure)}`
        );
        continue;
      }
      entries.push(runtimeHarness.success);
    }
    return {
      diagnostics,
      entries,
    } satisfies ImportedHarnessFile;
  }
);

export interface ImportHarnessFileOptions {
  readonly exportName?: string | undefined;
  readonly moduleNamespace?: FeatureModuleNamespace | undefined;
}

export const importHarnessFile = Effect.fn("ContributionLoader.harnessFile")(
  function* (
    feature: ResolvedFeature,
    absolute: string,
    options?: ImportHarnessFileOptions
  ) {
    const imported = yield* importHarnessExport(
      absolute,
      options?.exportName,
      options?.moduleNamespace
    ).pipe(Effect.result);

    if (Result.isFailure(imported)) {
      return {
        diagnostics: [
          `could not import harness for feature "${feature.id}": ${formatUnknownError(imported.failure)}`,
        ],
        entries: [],
      } satisfies ImportedHarnessFile;
    }

    return yield* importHarnessValues(feature, imported.success);
  }
);

export const importHarnessContributionsFromFeatures = Effect.fn(
  "ContributionLoader.harnessFromFeatures"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;

  const sets: ImportedHarnesses[] = [];

  for (const feature of features) {
    if (!feature.valid) {
      sets.push(
        disabledFeatureContributionSet<RuntimeHarness>("harness", feature)
      );
      continue;
    }

    const contribution = feature.contributions.find(
      (c) => c.kind === "harness"
    );
    if (!contribution) {
      continue;
    }
    const absolute = makeContributionSourcePath({
      contribution,
      feature,
      featuresRoot,
      joinPath: path.join,
    });
    const result = yield* importHarnessFile(feature, absolute, {
      exportName: contribution.exportName,
      moduleNamespace: contribution.moduleNamespace,
    });
    sets.push(
      makeProjectContributionSet({
        diagnostics: result.diagnostics,
        entries: result.entries,
        feature,
        kind: "harness",
        sourcePath: absolute,
      })
    );
  }

  const { diagnostics, entries, records } = combineContributionSets(sets);
  return {
    diagnostics,
    entries,
    records,
  } satisfies ImportedHarnesses;
});

/**
 * Boot step 5–6 for the `harness` kind (RFC 0003): discover features, dynamic-
 * import each resolved harness export, structurally validate its plain
 * TypeScript value, adapt it into the internal branded harness shape,
 * and return the valid entries with diagnostics for disabled ones.
 */
export const importHarnessContributions = Effect.fn(
  "ContributionLoader.harness"
)(function* (featuresRoot: string) {
  const { features } = yield* discoverFeatures(featuresRoot);
  return yield* importHarnessContributionsFromFeatures(featuresRoot, features);
});
