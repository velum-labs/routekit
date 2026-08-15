import { Crypto, Effect, FileSystem, Layer, Path, Ref } from "effect";

import type { SingleFlight } from "../event/single-flight.ts";
import type { FeatureRuntimeShape } from "./service.ts";

import { SelectedAdapterCoordinator } from "../../../../engine/selected-adapter/src/coordinator.ts";
import { AgentInvokeCell } from "../agent/invoke-cell.ts";
import { FeatureCatalog } from "../catalog/feature.ts";
import { makeSingleFlight } from "../event/single-flight.ts";
import {
  degradedBootDiagnostics,
  runtimeFatalBootDiagnostics,
} from "../feature-boot/diagnostics.ts";
import { FeatureImportPolicy } from "../feature-boot/import-policy.ts";
import {
  bootFeatureProject,
  formatStructuredFeatureBootDiagnostics,
} from "../feature-boot/index.ts";
import {
  initializeFeatureStateStore,
  makeInvalidFeatureBootError,
  mapFeatureBootError,
  provideBootServices,
  resolveFeaturesRoot,
} from "../feature-boot/services.ts";
import { commitFeatureBootResult } from "./cache.ts";
import { FeatureRuntime } from "./service.ts";
import {
  withAffectedModuleImportScope,
  withFreshModuleBuildPolicy,
} from "../../../../utils/core/src/module-loader.ts";

type FeatureBootResult =
  ReturnType<typeof bootFeatureProject> extends Effect.Effect<
    infer Success,
    unknown,
    unknown
  >
    ? Success
    : never;

type FeatureRuntimeError =
  ReturnType<FeatureRuntimeShape["boot"]> extends Effect.Effect<
    unknown,
    infer Failure,
    unknown
  >
    ? Failure
    : never;

interface ReloadOptions {
  readonly affectedFeatureIds?: readonly string[];
}

interface FeatureRuntimeDeps {
  readonly agentInvoke: AgentInvokeCell["Service"];
  readonly bootFlight: SingleFlight<
    string,
    FeatureBootResult,
    FeatureRuntimeError
  >;
  readonly builtIns: FeatureCatalog["Service"];
  readonly cache: Ref.Ref<Map<string, FeatureBootResult>>;
  readonly coordinator: SelectedAdapterCoordinator["Service"];
  readonly crypto: Crypto.Crypto;
  readonly featureImportPolicy: FeatureImportPolicy["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Build the `bootFeatureProject` argument from the built-in catalog and the
 * previous boot's reuse hints — split out of {@link makeFeatureRuntime} so the
 * boot closure stays small.
 */
interface BootProjectInputArgs {
  readonly deps: FeatureRuntimeDeps;
  readonly resolvedRoot: string;
  readonly previousBoot: FeatureBootResult | undefined;
  readonly options?: ReloadOptions | undefined;
}

const makeBootProjectInput = ({
  deps,
  resolvedRoot,
  previousBoot,
  options,
}: BootProjectInputArgs): Parameters<typeof bootFeatureProject>[0] => ({
  availableHarnessNames: deps.builtIns.availableHarnessNames,
  builtInApis: deps.builtIns.apis,
  builtInChats: deps.builtIns.chats,
  builtInCodeSkillSuggestions: deps.builtIns.codeSkillSuggestions,
  builtInDbs: deps.builtIns.dbs,
  builtInDefaultDbName: deps.builtIns.defaultDbName,
  builtInDefaultHarnessName: deps.builtIns.defaultHarnessName,
  builtInDefaultHarnessPriority: deps.builtIns.defaultHarnessPriority,
  builtInHarnessDiagnostics: deps.builtIns.harnessDiagnostics,
  builtInHarnesses: deps.builtIns.harnesses,
  builtInPrompts: deps.builtIns.prompts,
  builtInSkills: deps.builtIns.skills,
  builtInSkillWarnings: deps.builtIns.warnings,
  disabledSkillNames: deps.builtIns.disabledSkillNames,
  featuresRoot: resolvedRoot,
  reload: {
    affectedFeatureIds: options?.affectedFeatureIds,
    previousFeatures: previousBoot?.definition.features,
    previousImported: previousBoot?.definition.imported,
    previousPackageInfos: previousBoot?.definition.packageInfos,
  },
});

type BuildBoot = (
  resolvedRoot: string,
  options?: ReloadOptions
) => Effect.Effect<FeatureBootResult, FeatureRuntimeError>;

const makeBuildBoot = (deps: FeatureRuntimeDeps): BuildBoot =>
  Effect.fn("FeatureRuntimeLive.buildBoot")(function* (
    resolvedRoot: string,
    options?: ReloadOptions
  ) {
    const previousBoot = (yield* Ref.get(deps.cache)).get(resolvedRoot);
    const boot = yield* withFreshModuleBuildPolicy(
      deps.featureImportPolicy,
      withAffectedModuleImportScope(
        {
          affectedFeatureIds: options?.affectedFeatureIds,
          featuresRoot: resolvedRoot,
        },
        bootFeatureProject(
          makeBootProjectInput({
            deps,
            options,
            previousBoot,
            resolvedRoot,
          })
        )
      )
    ).pipe(
      Effect.provideService(AgentInvokeCell, deps.agentInvoke),
      provideBootServices({
        coordinator: deps.coordinator,
        crypto: deps.crypto,
        fs: deps.fs,
        path: deps.path,
      }),
      mapFeatureBootError
    );
    yield* initializeFeatureStateStore(boot, {
      affectedFeatureIds:
        previousBoot === undefined ? undefined : options?.affectedFeatureIds,
      previousBoot,
    });
    // Logged here rather than in `boot` so the notice fires once per real boot
    // or reload. `boot` serves later turns from the cache, and repeating this on
    // every turn would bury the session in the same warning. Suppressed when the
    // same boot also carries a fatal diagnostic: `boot` is about to fail, and
    // "degraded, N skipped" immediately above "boot failed" reads as if the
    // runtime came up.
    const degraded =
      runtimeFatalBootDiagnostics(boot.structuredDiagnostics).length > 0
        ? []
        : degradedBootDiagnostics(boot.structuredDiagnostics);
    if (degraded.length > 0) {
      yield* Effect.logWarning(
        `feature boot degraded; ${degraded.length} contribution(s) skipped and unavailable this session:\n${formatStructuredFeatureBootDiagnostics(degraded)}`
      );
    }
    return boot;
  });

/** Build the {@link FeatureRuntimeShape} from the boot/inspect/reload closures. */
const assembleFeatureRuntime = (
  inspect: (
    featuresRoot: string
  ) => Effect.Effect<FeatureBootResult, FeatureRuntimeError>,
  prepareReload: (
    featuresRoot: string,
    options?: ReloadOptions
  ) => Effect.Effect<
    { readonly boot: FeatureBootResult; readonly commit: Effect.Effect<void> },
    FeatureRuntimeError
  >
): FeatureRuntimeShape =>
  FeatureRuntime.of({
    boot: (featuresRoot) =>
      Effect.gen(function* () {
        const boot = yield* inspect(featuresRoot);
        const fatal = runtimeFatalBootDiagnostics(boot.structuredDiagnostics);
        if (fatal.length > 0) {
          return yield* makeInvalidFeatureBootError(
            `feature boot failed:\n${formatStructuredFeatureBootDiagnostics(fatal)}`
          );
        }
        return boot;
      }),
    inspect,
    inspectDefinition: (featuresRoot) =>
      inspect(featuresRoot).pipe(Effect.map((boot) => boot.definition)),
    prepareReload,
    reload: (featuresRoot, options) =>
      Effect.gen(function* () {
        const prepared = yield* prepareReload(featuresRoot, options);
        yield* prepared.commit;
        return prepared.boot;
      }),
  });

const makeFeatureRuntime = (deps: FeatureRuntimeDeps): FeatureRuntimeShape => {
  const buildBoot = makeBuildBoot(deps);

  const commitBoot = (
    resolvedRoot: string,
    boot: FeatureBootResult,
    options?: ReloadOptions
  ): Effect.Effect<void> =>
    commitFeatureBootResult({
      affectedFeatureIds: options?.affectedFeatureIds,
      boot,
      cache: deps.cache,
      resolvedRoot,
    });

  const bootResolvedRoot = Effect.fn("FeatureRuntimeLive.bootResolvedRoot")(
    function* (resolvedRoot: string, options?: ReloadOptions) {
      const boot = yield* buildBoot(resolvedRoot, options);
      yield* commitBoot(resolvedRoot, boot, options);
      return boot;
    }
  );

  const prepareReload = Effect.fn("FeatureRuntimeLive.prepareReload")(
    function* (featuresRoot: string, options?: ReloadOptions) {
      const resolvedRoot = yield* resolveFeaturesRoot(
        deps.fs,
        deps.path,
        featuresRoot
      );
      const boot = yield* buildBoot(resolvedRoot, options);
      return {
        boot,
        commit: commitBoot(resolvedRoot, boot, options),
      };
    }
  );

  const inspect = Effect.fn("FeatureRuntimeLive.inspect")(function* (
    featuresRoot: string
  ) {
    const resolvedRoot = yield* resolveFeaturesRoot(
      deps.fs,
      deps.path,
      featuresRoot
    );
    const cached = (yield* Ref.get(deps.cache)).get(resolvedRoot);
    if (cached) {
      return cached;
    }

    return yield* deps.bootFlight.run(
      resolvedRoot,
      Effect.gen(function* () {
        const latestCached = (yield* Ref.get(deps.cache)).get(resolvedRoot);
        return latestCached ?? (yield* bootResolvedRoot(resolvedRoot));
      })
    );
  });

  return assembleFeatureRuntime(inspect, prepareReload);
};

// `AgentInvokeCell` is provided AND re-exposed here rather than built into a
// shared layer file: the cell has to be the same instance the daemon publishes
// into and feature boot reads from, and this is the narrowest layer both sit
// under. `provideMerge` keeps it visible to `daemon-server` and the schedule
// runner without every consumer having to wire its own.
export const featureRuntimeLayer = Layer.effect(FeatureRuntime)(
  Effect.gen(function* () {
    const deps: FeatureRuntimeDeps = {
      agentInvoke: yield* AgentInvokeCell,
      bootFlight: yield* makeSingleFlight<
        string,
        FeatureBootResult,
        FeatureRuntimeError
      >(),
      builtIns: yield* FeatureCatalog,
      cache: yield* Ref.make(new Map<string, FeatureBootResult>()),
      coordinator: yield* SelectedAdapterCoordinator,
      crypto: yield* Crypto.Crypto,
      featureImportPolicy: yield* FeatureImportPolicy,
      fs: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
    };
    return makeFeatureRuntime(deps);
  })
).pipe(Layer.provideMerge(AgentInvokeCell.layer));
