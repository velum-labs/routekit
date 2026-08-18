import type { FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { Data, Effect, Option, Schema } from "effect";

import type {
  FeatureModuleNamespace,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";
import type { ModuleLoaderError } from "../../../../utils/core/src/module-loader.ts";

import { ChatContributionSchema } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import {
  decodeDefaultExportValues,
  importFreshDefaultExport,
  importFreshNamedExport,
} from "../../../../utils/core/src/module-loader.ts";

interface ImportResult<Entry> {
  readonly diagnostics: readonly string[];
  readonly entries: readonly Entry[];
}

interface ImportedValues {
  readonly diagnostics: readonly string[];
  readonly values: readonly unknown[];
}

interface NamedImportOptions<Value> {
  readonly absolute: string;
  readonly decode: (value: unknown) => Effect.Effect<Value, Schema.SchemaError>;
  readonly feature: ResolvedFeature;
  readonly exportName?: string;
  readonly getName: (value: Value) => string | undefined;
  readonly kind: string;
  readonly makeName?: (value: Value, feature: ResolvedFeature) => string;
  readonly moduleNamespace?: FeatureModuleNamespace;
}

const decodeChat = Schema.decodeUnknownEffect(ChatContributionSchema);

const getContributionName = (value: {
  readonly name?: string;
}): string | undefined => value.name;

const importContributionExport = (
  absolute: string,
  exportName: string | undefined,
  moduleNamespace: FeatureModuleNamespace | undefined
): Effect.Effect<
  readonly unknown[],
  ModuleLoaderError | PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> => {
  if (exportName !== undefined && moduleNamespace !== undefined) {
    return decodeDefaultExportValues(moduleNamespace[exportName]);
  }

  return (
    exportName === undefined
      ? importFreshDefaultExport(absolute)
      : importFreshNamedExport(absolute, exportName)
  ).pipe(Effect.flatMap(decodeDefaultExportValues));
};

const importContributionValues = <Value>(
  options: NamedImportOptions<Value>
): Effect.Effect<ImportedValues, never, FileSystem.FileSystem | Path.Path> =>
  importContributionExport(
    options.absolute,
    options.exportName,
    options.moduleNamespace
  ).pipe(
    Effect.option,
    Effect.map((imported) => {
      if (Option.isNone(imported)) {
        return {
          diagnostics: [
            `could not import ${options.kind} for feature "${options.feature.id}"`,
          ],
          values: [],
        };
      }
      return {
        diagnostics: [],
        values: imported.value,
      };
    })
  );

type NormalizedNamedContribution = Data.TaggedEnum<{
  // `Record<never, never>` lets `MissingName()` be called with no argument
  // without tripping no-empty-object-type/ban-types.
  MissingName: Record<never, never>;
  Value: { readonly value: unknown };
}>;

const NormalizedNamedContribution =
  Data.taggedEnum<NormalizedNamedContribution>();

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeNamedContributionValue = <Value>(
  value: unknown,
  total: number,
  options: NamedImportOptions<Value>
): NormalizedNamedContribution => {
  if (!isObjectRecord(value)) {
    return NormalizedNamedContribution.Value({ value });
  }

  const hasDeclaredName = typeof value.name === "string";
  if (total > 1 && !hasDeclaredName) {
    return NormalizedNamedContribution.MissingName();
  }

  if (total === 1 && !hasDeclaredName) {
    return NormalizedNamedContribution.Value({
      value: {
        ...value,
        name: options.feature.id,
      },
    });
  }

  return NormalizedNamedContribution.Value({ value });
};

const emptyImportResult = <Entry>(diagnostic: string): ImportResult<Entry> => ({
  diagnostics: [diagnostic],
  entries: [],
});

const diagnosticsOnlyResult = <Entry>(
  diagnostics: readonly string[]
): ImportResult<Entry> => ({
  diagnostics,
  entries: [],
});

const singleEntryResult = <Entry>(entry: Entry): ImportResult<Entry> => ({
  diagnostics: [],
  entries: [entry],
});

const namedContributionToEntry = <Value>(
  entry: {
    readonly contribution: Value;
    readonly index: number;
    readonly total: number;
  },
  options: NamedImportOptions<Value>
): ImportResult<NamedContributionEntry<Value>> => {
  const { contribution, index, total } = entry;
  const declaredName = options.getName(contribution);

  if (total > 1 && declaredName === undefined) {
    return emptyImportResult(
      `${options.kind} export ${index + 1} for feature "${options.feature.id}" must define name`
    );
  }

  return singleEntryResult({
    featureId: options.feature.id,
    name:
      options.makeName?.(contribution, options.feature) ??
      declaredName ??
      options.feature.id,
    value: contribution,
  });
};

const decodeNamedContributionValue = <Value>(
  entry: {
    readonly value: unknown;
    readonly index: number;
    readonly total: number;
  },
  options: NamedImportOptions<Value>
): Effect.Effect<ImportResult<NamedContributionEntry<Value>>> => {
  const { value, index, total } = entry;
  return Effect.succeed(
    normalizeNamedContributionValue(value, total, options)
  ).pipe(
    Effect.flatMap(
      NormalizedNamedContribution.$match({
        MissingName: () =>
          Effect.succeed(
            emptyImportResult<NamedContributionEntry<Value>>(
              `${options.kind} export ${index + 1} for feature "${options.feature.id}" must define name`
            )
          ),
        Value: ({ value: normalizedValue }) =>
          options.decode(normalizedValue).pipe(
            Effect.option,
            Effect.map((decoded) => {
              if (Option.isNone(decoded)) {
                return emptyImportResult<NamedContributionEntry<Value>>(
                  `${options.kind} export ${index + 1} for feature "${options.feature.id}" is not valid`
                );
              }
              return namedContributionToEntry(
                {
                  contribution: decoded.value,
                  index: entry.index,
                  total: entry.total,
                },
                options
              );
            })
          ),
      })
    )
  );
};

const combineImportResults = <Entry>(
  results: readonly ImportResult<Entry>[]
): ImportResult<Entry> => ({
  diagnostics: results.flatMap((result) => result.diagnostics),
  entries: results.flatMap((result) => result.entries),
});

const importNamedContributionFile = <Value>(
  options: NamedImportOptions<Value>
): Effect.Effect<
  ImportResult<NamedContributionEntry<Value>>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  importContributionValues(options).pipe(
    Effect.flatMap((imported) =>
      Effect.all(
        imported.values.map((value, index) =>
          decodeNamedContributionValue(
            {
              index,
              total: imported.values.length,
              value,
            },
            options
          )
        )
      ).pipe(
        Effect.map((decoded) =>
          combineImportResults([
            diagnosticsOnlyResult<NamedContributionEntry<Value>>(
              imported.diagnostics
            ),
            ...decoded,
          ])
        )
      )
    )
  );

export interface ImportChatFileOptions {
  readonly exportName?: string | undefined;
  readonly moduleNamespace?: FeatureModuleNamespace | undefined;
}

export const importChatFile = (
  feature: ResolvedFeature,
  absolute: string,
  options?: ImportChatFileOptions
): Effect.Effect<
  ImportResult<NamedContributionEntry<typeof ChatContributionSchema.Type>>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  importNamedContributionFile({
    absolute,
    decode: decodeChat,
    ...(options?.exportName ? { exportName: options.exportName } : {}),
    feature,
    getName: getContributionName,
    kind: "chat",
    ...(options?.moduleNamespace
      ? { moduleNamespace: options.moduleNamespace }
      : {}),
  });
