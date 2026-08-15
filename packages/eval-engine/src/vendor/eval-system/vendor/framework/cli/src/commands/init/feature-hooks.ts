import type { FileSystem, Path, PlatformError } from "effect";

import { Effect } from "effect";

import type { FeatureLoaderError } from "../../../../contracts/internal/src/errors.ts";

import type { FeatureApiSource } from "./feature-declaration.ts";

import {
  renderFeatureDeclaration,
  writeFeatureDeclaration,
} from "./feature-declaration.ts";

const GENERATED_HOOK_TYPE_HELPER = `type __RouteKitEvalFeatureHook<
  T,
  K extends PropertyKey,
> = T extends { readonly default: { readonly api: { readonly hooks: infer H } } }
  ? K extends keyof H
    ? H[K]
    : never
  : T extends { readonly api: { readonly hooks: infer H } }
    ? K extends keyof H
      ? H[K]
      : never
    : never;`;

interface FeatureHooksDeclarationInput {
  readonly featureId: string;
  readonly hookKeys: readonly string[];
  readonly modulePath: string;
}

const featureHooksDeclarationInputs = (
  sources: readonly FeatureApiSource[]
): readonly FeatureHooksDeclarationInput[] =>
  sources.flatMap((source) =>
    source.api.hooks === undefined
      ? []
      : [
          {
            featureId: source.featureId,
            hookKeys: Object.keys(source.api.hooks).toSorted(),
            modulePath: source.modulePath,
          },
        ]
  );

export const renderFeatureHooksDeclaration = (
  inputs: readonly FeatureHooksDeclarationInput[]
): string =>
  renderFeatureDeclaration({
    entries: inputs,
    interfaceName: "FeatureHooks",
    toDeclarationLines: (input) =>
      input.hookKeys.map(
        (hookKey) =>
          `    "${input.featureId}.${hookKey}": __RouteKitEvalFeatureHook<typeof import("${input.modulePath}"), "${hookKey}">;`
      ),
    typeHelper: GENERATED_HOOK_TYPE_HELPER,
  });

export const generateFeatureHooksDeclaration = Effect.fn(
  "ProjectInit.generateFeatureHooksDeclaration"
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
    fileName: "feature-hooks.d.ts",
    projectRoot: input.projectRoot,
    render: (sources) =>
      renderFeatureHooksDeclaration(featureHooksDeclarationInputs(sources)),
  });
});

export type { FeatureHooksDeclarationInput };
