import { Crypto, Effect, FileSystem, Layer, Path } from "effect";

import type { ManagedSkillFetcher } from "../contributions/managed-skill-fetcher.ts";
import type { FeatureBootResult } from "./types.ts";

import { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import { fetchHttpClientLayer } from "../../../../contracts/internal/src/http-client.ts";
import { AgentHarnessAdapter } from "../../../../engine/harness/src/adapter.ts";
import { AgentHarnessContributionDecoder } from "../../../../engine/harness/src/contribution-decoder.ts";
import { SelectedAdapterCoordinator } from "../../../../engine/selected-adapter/src/coordinator.ts";
import { ManagedSkillFetcherLive } from "../contributions/managed-skill-fetcher-live.ts";
import { resolveStateStore } from "./state-store.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const provideBootServices =
  (services: {
    readonly coordinator: SelectedAdapterCoordinator["Service"];
    readonly crypto: Crypto.Crypto;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) =>
  <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>
  ): Effect.Effect<
    Value,
    Error,
    Exclude<
      Exclude<
        Exclude<
          Exclude<Exclude<Requirements, FileSystem.FileSystem>, Path.Path>,
          Crypto.Crypto
        >,
        SelectedAdapterCoordinator
      >,
      | AgentHarnessAdapter
      | AgentHarnessContributionDecoder
      | ManagedSkillFetcher
    >
  > =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, services.fs),
      Effect.provideService(Path.Path, services.path),
      Effect.provideService(Crypto.Crypto, services.crypto),
      Effect.provideService(SelectedAdapterCoordinator, services.coordinator),
      Effect.provide(
        Layer.mergeAll(
          AgentHarnessAdapter.layer,
          AgentHarnessContributionDecoder.layer,
          ManagedSkillFetcherLive.pipe(Layer.provide(fetchHttpClientLayer))
        )
      )
    );

const makeInvalidFeatureBootError = (detail: string): RuntimeServerError =>
  new RuntimeServerError({
    detail,
    operation: "booting feature runtime",
  });

const formatUnknownFeatureBootFailure = (cause: unknown): string =>
  formatUnknownError(cause);

const mapFeatureBootError = Effect.mapError(
  (cause: unknown) =>
    new RuntimeServerError({
      cause,
      detail: formatUnknownFeatureBootFailure(cause),
      operation: "booting feature runtime",
    })
);

const resolveFeaturesRoot = Effect.fn("FeatureRuntime.resolveFeaturesRoot")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, input: string) {
    const resolved = path.resolve(input);
    const nestedFeatures = path.join(resolved, "features");
    const hasNestedFeatures = yield* fs.exists(nestedFeatures).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeServerError({
            cause,
            detail: formatUnknownFeatureBootFailure(cause),
            operation: "resolving feature root",
          })
      )
    );
    return hasNestedFeatures ? nestedFeatures : resolved;
  }
);

const shouldInitializeStateStore = (
  boot: FeatureBootResult,
  options: {
    readonly affectedFeatureIds?: readonly string[] | undefined;
    readonly previousBoot?: FeatureBootResult | undefined;
  }
): boolean => {
  if (options.affectedFeatureIds === undefined) {
    return true;
  }

  const affected = new Set(options.affectedFeatureIds);
  return (
    boot.dbEntries.some((entry) => affected.has(entry.featureId)) ||
    (options.previousBoot?.dbEntries.some((entry) =>
      affected.has(entry.featureId)
    ) ??
      false)
  );
};

const formatFeatureRuntimeDiagnostics = (
  diagnostics: readonly string[]
): string => diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n");

export const initializeFeatureStateStore = Effect.fn(
  "FeatureRuntime.initializeStateStore"
)(function* (
  boot: FeatureBootResult,
  options?: {
    readonly affectedFeatureIds?: readonly string[] | undefined;
    readonly previousBoot?: FeatureBootResult | undefined;
  }
) {
  if (!boot.valid) {
    return;
  }

  if (
    !shouldInitializeStateStore(boot, {
      affectedFeatureIds: options?.affectedFeatureIds,
      previousBoot: options?.previousBoot,
    })
  ) {
    return;
  }

  const state = yield* resolveStateStore({
    dbEntries: boot.dbEntries,
    defaultStoreName: boot.runtimeGraph.selections.db.selected?.name,
  });
  if (state.diagnostics.length === 0) {
    return;
  }

  return yield* new RuntimeServerError({
    detail: `state store initialization failed:\n${formatFeatureRuntimeDiagnostics(state.diagnostics)}`,
    operation: "initializing feature state store",
  });
});

export {
  provideBootServices,
  makeInvalidFeatureBootError,
  formatUnknownFeatureBootFailure,
  mapFeatureBootError,
  resolveFeaturesRoot,
};
