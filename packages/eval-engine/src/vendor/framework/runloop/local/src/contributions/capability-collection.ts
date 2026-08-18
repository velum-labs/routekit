import type { FileSystem } from "effect";

import { Effect, Path } from "effect";

import type { ChatContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type {
  ResolvedContribution,
  ResolvedFeature,
} from "../../../../engine/features/src/feature-loader-types.ts";
import type { ImportedContribution } from "./imported-contribution.ts";
import type { ImportedNamedContributions } from "../feature-boot/contributions.ts";

import { BuiltinName } from "../../../../contracts/internal/src/builtin-name.ts";
import { importChatFile } from "./capability-files.ts";
import {
  combineContributionSets,
  disabledFeatureContributionSet,
  makeProjectContributionSet,
} from "./imported-contribution.ts";

type NamedContributionEntry<Value> =
  ImportedNamedContributions<Value>["entries"][number];

interface NamedCapabilityImportInput<Value> {
  readonly entryKey: string;
  readonly features: readonly ResolvedFeature[];
  readonly featuresRoot: string;
  readonly importFile: (
    feature: ResolvedFeature,
    absolute: string,
    options?: {
      exportName?: string | undefined;
      moduleNamespace?: ResolvedContribution["moduleNamespace"];
    }
  ) => Effect.Effect<
    {
      readonly diagnostics: readonly string[];
      readonly entries: readonly NamedContributionEntry<Value>[];
    },
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly kind: ImportedContribution<Value>["kind"];
}

interface NamedFeatureImportInput<
  Value,
> extends NamedCapabilityImportInput<Value> {
  readonly feature: ResolvedFeature;
  readonly path: Path.Path;
}

const contributionSourcePath = <Value>(
  input: NamedFeatureImportInput<Value>,
  contribution: ResolvedContribution
): string =>
  input.path.join(input.featuresRoot, input.feature.id, contribution.file);

const findContributions = (
  feature: ResolvedFeature,
  entryKey: string
): readonly ResolvedContribution[] =>
  feature.contributions.filter(
    (contribution) => contribution.entryKey === entryKey
  );

const importNamedContribution = <Value>(
  input: NamedFeatureImportInput<Value>,
  contribution: ResolvedContribution
): Effect.Effect<
  ImportedNamedContributions<Value>,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  const absolute = contributionSourcePath(input, contribution);

  return input
    .importFile(input.feature, absolute, {
      exportName: contribution.exportName,
      moduleNamespace: contribution.moduleNamespace,
    })
    .pipe(
      Effect.map(
        (result): ImportedNamedContributions<Value> =>
          makeProjectContributionSet({
            diagnostics: result.diagnostics,
            entries: result.entries,
            feature: input.feature,
            kind: input.kind,
            // The built-in chat surface yields to a project feature that
            // contributes a chat of the same reserved name. Narrower than
            // built-in feature shadowing and still needed: this fires for a
            // feature under any directory name, where feature shadowing only
            // fires for `features/chat-tui/`.
            shadows: (entry) =>
              input.kind === "chat" && entry.name === BuiltinName.Chat,
            sourcePath: absolute,
          })
      )
    );
};

const importFeatureNamedContributions = <Value>(
  input: NamedFeatureImportInput<Value>
): Effect.Effect<
  ImportedNamedContributions<Value>,
  never,
  FileSystem.FileSystem | Path.Path
> => {
  if (!input.feature.valid) {
    return Effect.succeed(
      disabledFeatureContributionSet<NamedContributionEntry<Value>>(
        input.kind,
        input.feature
      )
    );
  }

  return Effect.all(
    findContributions(input.feature, input.entryKey).map((contribution) =>
      importNamedContribution(input, contribution)
    )
  ).pipe(Effect.map(combineContributionSets));
};

const importNamedCapabilityContributionsFromFeatures = Effect.fn(
  "CapabilityCollection.importNamedCapabilityContributionsFromFeatures"
)(function* <Value>(input: NamedCapabilityImportInput<Value>) {
  const path = yield* Path.Path;

  return combineContributionSets(
    yield* Effect.all(
      input.features.map((feature) =>
        importFeatureNamedContributions({
          ...input,
          feature,
          path,
        })
      )
    )
  );
});

export const importChatContributionsFromFeatures = (
  featuresRoot: string,
  features: readonly ResolvedFeature[]
): Effect.Effect<
  ImportedNamedContributions<ChatContribution>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  importNamedCapabilityContributionsFromFeatures({
    entryKey: "chat",
    features,
    featuresRoot,
    importFile: importChatFile,
    kind: "chat",
  });
