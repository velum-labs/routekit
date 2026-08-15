import type { FileSystem, Path, PlatformError } from "effect";

import { Effect } from "effect";

import type { FeatureLoaderError } from "../../../../contracts/internal/src/errors.ts";

import type { FeatureApiSource } from "./feature-declaration.ts";

import {
  renderFeatureDeclaration,
  writeFeatureDeclaration,
} from "./feature-declaration.ts";

const GENERATED_API_TYPE_HELPER = `type __RouteKitEvalFeatureApi<T> = T extends {
  readonly default: { readonly api: { readonly exports: infer E } };
}
  ? E
  : T extends { readonly api: { readonly exports: infer E } }
    ? E
    : never;`;

interface FeatureApisDeclarationInput {
  readonly featureId: string;
  readonly modulePath: string;
}

const featureApisDeclarationInputs = (
  sources: readonly FeatureApiSource[]
): readonly FeatureApisDeclarationInput[] =>
  sources.flatMap((source) =>
    source.api.exports === undefined
      ? []
      : [
          {
            featureId: source.featureId,
            modulePath: source.modulePath,
          },
        ]
  );

export const renderFeatureApisDeclaration = (
  inputs: readonly FeatureApisDeclarationInput[]
): string =>
  renderFeatureDeclaration({
    entries: inputs,
    interfaceName: "FeatureApis",
    toDeclarationLines: (input) => [
      `    "${input.featureId}": __RouteKitEvalFeatureApi<typeof import("${input.modulePath}")>;`,
    ],
    typeHelper: GENERATED_API_TYPE_HELPER,
  });

export const generateFeatureApisDeclaration = Effect.fn(
  "ProjectInit.generateFeatureApisDeclaration"
)(function* (input: {
  readonly featuresRoot: string;
  readonly projectRoot: string;
}): Effect.fn.Return<
  void,
  FeatureLoaderError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  yield* writeFeatureDeclaration({
    featuresRoot: input.featuresRoot,
    fileName: "feature-apis.d.ts",
    projectRoot: input.projectRoot,
    render: (sources) =>
      renderFeatureApisDeclaration(featureApisDeclarationInputs(sources)),
  });
});

export type { FeatureApisDeclarationInput };
