import type { FileSystem } from "effect";

import { Effect, Option, Path, Result, Schema } from "effect";

import type { CommandContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type {
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";
import type { ImportedNamedContributions } from "../feature-boot/contributions.ts";

import { decodeCommandContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import { NESTED_COMMAND_ENTRY_PREFIX } from "../../../../contracts/internal/src/author-schemas/feature-manifest.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeContributionSourcePath,
  makeProjectContributionSet,
} from "./imported-contribution.ts";
import { importFreshNamedExport } from "../../../../utils/core/src/module-loader.ts";

type CommandEntry =
  ImportedNamedContributions<CommandContribution>["entries"][number];

interface ImportedCommandFile {
  readonly diagnostics: readonly string[];
  readonly entries: readonly CommandEntry[];
}

interface CommandFeatureImportContext {
  readonly feature: ResolvedFeature;
  readonly featuresRoot: string;
  readonly path: Path.Path;
}

/**
 * The fallback registry name for a command whose contribution omits `name`: the
 * nested folder name for a `commands/<name>/command.ts` entry, otherwise the
 * feature id (a top-level `command.ts` or the `feature.ts` `command` export). A
 * contribution's own `name` always wins over this; it is required for entries in
 * a `commands` array, where there is no single path to derive a name from.
 */
const fallbackCommandName = (
  feature: ResolvedFeature,
  contribution: ResolvedContribution
): string =>
  contribution.entryKey.startsWith(NESTED_COMMAND_ENTRY_PREFIX)
    ? contribution.entryKey.slice(NESTED_COMMAND_ENTRY_PREFIX.length)
    : feature.id;

const emptyCommandFileResult = (diagnostic: string): ImportedCommandFile => ({
  diagnostics: [diagnostic],
  entries: [],
});

const commandEntry = (
  feature: ResolvedFeature,
  name: string,
  value: CommandContribution
): CommandEntry => ({
  featureId: feature.id,
  name,
  value,
});

/**
 * Decode one authored value into a named command entry. A `commands`-array entry
 * has no path to fall back on, so its contribution MUST declare `name`; the
 * single forms fall back to {@link fallbackCommandName}.
 */
interface DecodeCommandInput {
  readonly feature: ResolvedFeature;
  readonly sourcePath: string;
  readonly value: unknown;
  readonly fallbackName: string;
  readonly requireName: boolean;
}

interface ImportCommandExportInput {
  readonly feature: ResolvedFeature;
  readonly sourcePath: string;
  readonly value: unknown;
  readonly fallbackName: string;
}

const LegacyCommandHookSchema = Schema.Struct({
  type: Schema.Literal("commandHook"),
});

const decodeCommandValue = Effect.fn("ContributionLoader.decodeCommandValue")(
  function* (input: DecodeCommandInput) {
    const { feature, sourcePath, value, fallbackName, requireName } = input;
    const decoded = yield* decodeCommandContribution(value).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      const message = Schema.is(LegacyCommandHookSchema)(value)
        ? `command "${fallbackName}" for feature "${feature.id}" at "${sourcePath}" uses the removed legacy shape \`type: "commandHook"\` with \`run(args, ctx)\`; migrate to a named \`command\` export from \`defineCommand\` with \`run(ctx)\` returning \`{ ok, message?, data? }\``
        : `command "${fallbackName}" for feature "${feature.id}" at "${sourcePath}" is invalid: ${String(decoded.failure)}`;
      return emptyCommandFileResult(message);
    }
    const contribution = decoded.success;
    if (requireName && contribution.name === undefined) {
      return emptyCommandFileResult(
        `command in feature "${feature.id}" "commands" array is missing a required "name"`
      );
    }
    return {
      diagnostics: [],
      entries: [
        commandEntry(feature, contribution.name ?? fallbackName, contribution),
      ],
    } satisfies ImportedCommandFile;
  }
);

/** A `feature.ts` `command` export (single) or `commands` export (array). */
const importCommandExport = Effect.fn("ContributionLoader.commandExport")(
  function* (input: ImportCommandExportInput) {
    const { feature, sourcePath, value, fallbackName } = input;
    if (Array.isArray(value)) {
      const results = yield* Effect.all(
        value.map((item) =>
          decodeCommandValue({
            fallbackName,
            feature,
            requireName: true,
            sourcePath,
            value: item,
          })
        )
      );
      return {
        diagnostics: results.flatMap((result) => result.diagnostics),
        entries: results.flatMap((result) => result.entries),
      } satisfies ImportedCommandFile;
    }
    return yield* decodeCommandValue({
      fallbackName,
      feature,
      requireName: false,
      sourcePath,
      value,
    });
  }
);

/**
 * A standalone `command.ts` / `commands/<name>/command.ts`. The contribution is
 * the module's named `command` export (RFC 0002 command.md), never a default
 * export, mirroring the `schedule` and `api` contributions; a missing export
 * surfaces a precise diagnostic rather than a downstream decode failure on
 * `undefined`.
 */
const importCommandModuleFile = Effect.fn(
  "ContributionLoader.commandModuleFile"
)(function* (feature: ResolvedFeature, absolute: string, fallbackName: string) {
  const imported = yield* importFreshNamedExport(absolute, "command").pipe(
    Effect.option
  );
  if (Option.isNone(imported)) {
    return emptyCommandFileResult(
      `could not import command "${fallbackName}" for feature "${feature.id}"`
    );
  }
  if (imported.value === undefined) {
    return emptyCommandFileResult(
      `command "${fallbackName}" for feature "${feature.id}" must export a named "command" (e.g. \`export const command = defineCommand(...)\`), not a default export`
    );
  }
  return yield* decodeCommandValue({
    fallbackName,
    feature,
    requireName: false,
    sourcePath: absolute,
    value: imported.value,
  });
});

const importCommandSource = (
  feature: ResolvedFeature,
  source: {
    readonly contribution: ResolvedContribution;
    readonly absolute: string;
  },
  fallbackName: string
): Effect.Effect<
  ImportedCommandFile,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const { contribution, absolute } = source;
  if (
    contribution.exportName !== undefined &&
    contribution.moduleNamespace !== undefined
  ) {
    return importCommandExport({
      feature,
      fallbackName,
      sourcePath: absolute,
      value: contribution.moduleNamespace[contribution.exportName],
    });
  }
  return importCommandModuleFile(feature, absolute, fallbackName);
};

const importCommandContribution = (
  context: CommandFeatureImportContext,
  contribution: ResolvedContribution
): Effect.Effect<
  ImportedNamedContributions<CommandContribution>,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const absolute = makeContributionSourcePath({
    contribution,
    feature: context.feature,
    featuresRoot: context.featuresRoot,
    joinPath: context.path.join,
  });
  const fallbackName = fallbackCommandName(context.feature, contribution);

  return importCommandSource(
    context.feature,
    {
      absolute,
      contribution,
    },
    fallbackName
  ).pipe(
    Effect.map(
      (result): ImportedNamedContributions<CommandContribution> =>
        makeProjectContributionSet({
          diagnostics: result.diagnostics,
          entries: result.entries,
          feature: context.feature,
          kind: "command",
          sourcePath: absolute,
        })
    )
  );
};

const importFeatureCommandContributions = Effect.fn(
  "ContributionLoader.featureCommands"
)(function* (context: CommandFeatureImportContext) {
  if (!context.feature.valid) {
    return disabledFeatureContributionSet<
      NamedContributionEntry<CommandContribution>
    >("command", context.feature);
  }

  return combineContributionSets(
    yield* Effect.all(
      context.feature.contributions
        .filter((contribution) => contribution.kind === "command")
        .map((contribution) => importCommandContribution(context, contribution))
    )
  );
});

export const importCommandContributionsFromFeatures = Effect.fn(
  "ContributionLoader.commandsFromFeatures"
)(function* (featuresRoot: string, features: readonly ResolvedFeature[]) {
  const path = yield* Path.Path;
  return combineContributionSets(
    yield* Effect.all(
      features.map((feature) =>
        importFeatureCommandContributions({
          feature,
          featuresRoot,
          path,
        })
      )
    )
  );
});
