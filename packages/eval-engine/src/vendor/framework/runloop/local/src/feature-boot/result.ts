import { Context, Effect } from "effect";

import type { HookHandlerContext } from "../../../../contracts/author/src/hooks.ts";
import type { StoreResolver } from "../../../../contracts/author/src/stores.ts";
import type { StateStoreContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { FeatureDependencyPlan } from "../../../../engine/features/src/dependency-types.ts";
import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";
import type {
  ImportedFeatureContributions,
  RegisteredFeatureContributions,
} from "./contributions.ts";
import type { BootDiagnostic } from "./diagnostic-types.ts";
import type { FeatureBootOptions } from "./options.ts";
import type {
  FeatureDefinition,
  RuntimeGraph,
  RuntimeProviderSet,
  RuntimeSelections,
  StaticRegistrySet,
} from "./types.ts";
import type { HookRegistryShape } from "../hooks/registry.ts";
import type { AgentInvokeStream } from "../schedule/invoke.ts";
import type {
  ProviderOrigin,
  ProviderSelectionDiagnostic,
  ProviderSelectionResult,
} from "../../../../utils/core/src/provider-selection-support.ts";

import { requireAgentInvoke } from "../agent/invoke-cell.ts";
import { formatBootDiagnosticMessages } from "./diagnostics.ts";
import {
  makeCapabilityBootFields,
  makeStaticRegistrySet,
} from "./registries.ts";
import { HookRegistryLive } from "../hooks/live.ts";
import { HookRegistry } from "../hooks/registry.ts";
import { featureLoggerFromContext } from "../logging/support.ts";
import { makeAuthorInvoke } from "../schedule/invoke.ts";
import { resolveProviderSelection } from "../../../../utils/core/src/provider-selection.ts";

const providerSelectionToBootDiagnostic = (
  diagnostic: ProviderSelectionDiagnostic
): BootDiagnostic => ({
  code: diagnostic.code,
  contributionName: diagnostic.kind,
  entryKey: diagnostic.kind,
  level: diagnostic.level,
  message: diagnostic.message,
});

const makeProviderSelectionBootDiagnostics = (
  selections: RuntimeSelections
): readonly BootDiagnostic[] =>
  [...selections.diagnostics, ...selections.warnings].map((diagnostic) =>
    providerSelectionToBootDiagnostic(diagnostic)
  );

const makeBootDiagnosticSignature = (diagnostic: BootDiagnostic): string =>
  `${diagnostic.level}\u0000${diagnostic.message}`;

const appendUniqueBootDiagnostics = (
  base: readonly BootDiagnostic[],
  additions: readonly BootDiagnostic[]
): readonly BootDiagnostic[] => {
  const diagnostics = [...base];
  const seen = new Set(base.map(makeBootDiagnosticSignature));

  for (const diagnostic of additions) {
    const signature = makeBootDiagnosticSignature(diagnostic);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    diagnostics.push(diagnostic);
  }

  return diagnostics;
};

const makeHookContextFactory = (input: {
  readonly apiRegistry: StaticRegistrySet["apiRegistry"];
  readonly featureId: string;
  readonly invoke: () => AgentInvokeStream | undefined;
  readonly runtimeContext: Context.Context<never>;
  readonly stores: StoreResolver | undefined;
}): (() => HookHandlerContext) => {
  const apiContext = input.apiRegistry.contextFor(input.featureId);
  const invoke = makeAuthorInvoke({
    invoke: (invokeInput) => requireAgentInvoke(input.invoke)(invokeInput),
  });
  return (): HookHandlerContext => ({
    featureId: input.featureId,
    invoke,
    logger: featureLoggerFromContext(
      input.runtimeContext,
      `hook:${input.featureId}`
    ),
    stores: input.stores,
    use: apiContext.use,
  });
};

// Yield the `HookRegistry` tag rather than call `wireHookContributions`
// directly. The wiring input (especially `contextFor`, which closes over this
// boot's registries and runtime context) is per-boot data born here, not a
// value any static composition root holds, so `HookRegistryLive(input)` is
// discharged at this site — feature boot is the composition root for the hook
// path. The requirement never escapes this function.
const makeFeatureHookRegistry = (input: {
  readonly apiEntries: readonly FeatureDefinition["apiEntries"][number][];
  readonly dependencyPlan: FeatureDependencyPlan;
  readonly registered: RegisteredFeatureContributions;
  readonly registries: StaticRegistrySet;
  readonly invoke: () => AgentInvokeStream | undefined;
  readonly runtimeContext: Context.Context<never>;
}): Effect.Effect<HookRegistryShape> =>
  Effect.provide(
    HookRegistry,
    HookRegistryLive({
      apis: input.apiEntries,
      bootOrder: input.dependencyPlan.bootOrder,
      consumers: input.registered.hooks?.entries ?? [],
      contextFor: (featureId, stores) =>
        makeHookContextFactory({
          apiRegistry: input.registries.apiRegistry,
          featureId,
          invoke: input.invoke,
          runtimeContext: input.runtimeContext,
          stores,
        }),
      dependenciesByFeature: input.dependencyPlan.dependenciesByFeature,
    })
  );

/** Assemble the final {@link FeatureDefinition} object from its precomputed parts. */
const assembleFeatureDefinition = (parts: {
  readonly apiEntries: FeatureDefinition["apiEntries"];
  readonly capabilityFields: ReturnType<typeof makeCapabilityBootFields>;
  readonly diagnostics: readonly string[];
  readonly harnesses: FeatureDefinition["harnesses"];
  readonly input: {
    readonly dependencyPlan: FeatureDependencyPlan;
    readonly features: readonly ResolvedFeature[];
    readonly imported: ImportedFeatureContributions;
    readonly options: FeatureBootOptions;
    readonly registered: RegisteredFeatureContributions;
  };
  readonly modelProviders: FeatureDefinition["modelProviders"];
  readonly promptEntries: FeatureDefinition["promptEntries"];
  readonly registries: StaticRegistrySet;
  readonly skillEntries: FeatureDefinition["skillEntries"];
  readonly structuredDiagnostics: readonly BootDiagnostic[];
  readonly warnings: readonly string[];
}): FeatureDefinition => ({
  builtInCodeSkillSuggestions:
    parts.input.options.builtInCodeSkillSuggestions ?? [],
  apiEntries: parts.apiEntries,
  bootOrder: parts.input.dependencyPlan.bootOrder,
  chatEntries: parts.capabilityFields.chatEntries,
  commandEntries: parts.capabilityFields.commandEntries,
  dbEntries: parts.capabilityFields.dbEntries,
  dependenciesByFeature: parts.input.dependencyPlan.dependenciesByFeature,
  diagnostics: parts.diagnostics,
  enabledFeatures: parts.input.dependencyPlan.enabledFeatures,
  features: parts.input.features,
  harnesses: parts.harnesses,
  imported: parts.input.imported,
  modelProviders: parts.modelProviders,
  packageInfos: parts.input.dependencyPlan.packageInfos,
  promptEntries: parts.promptEntries,
  registered: parts.input.registered,
  registries: parts.registries,
  scheduleEntries: parts.capabilityFields.scheduleEntries,
  skillEntries: parts.skillEntries,
  structuredDiagnostics: parts.structuredDiagnostics,
  valid: parts.diagnostics.length === 0,
  warnings: parts.warnings,
});

/**
 * Merge the recorded boot diagnostics with the provider-selection diagnostics
 * (deduped) and split the combined set into error/warning message lists.
 */
const makeBootDiagnostics = (
  diagnosticRecords: readonly BootDiagnostic[],
  selections: RuntimeSelections
): {
  readonly diagnostics: readonly string[];
  readonly structuredDiagnostics: readonly BootDiagnostic[];
  readonly warnings: readonly string[];
} => {
  const structuredDiagnostics = appendUniqueBootDiagnostics(
    diagnosticRecords,
    makeProviderSelectionBootDiagnostics(selections)
  );
  return {
    diagnostics: formatBootDiagnosticMessages(structuredDiagnostics, "error"),
    structuredDiagnostics,
    warnings: formatBootDiagnosticMessages(structuredDiagnostics, "warning"),
  };
};

const resolveNamedProviderSelection = <
  Value extends StateStoreContribution,
>(input: {
  readonly builtInDefaultName?: string | undefined;
  readonly kind: string;
  readonly records: readonly {
    readonly entry: NamedContributionEntry<Value>;
    readonly featureId: string;
    readonly origin: ProviderOrigin;
  }[];
}): ProviderSelectionResult<Value> => {
  if (input.records.length === 0) {
    return {
      diagnostics: [],
      warnings: [],
    };
  }

  return resolveProviderSelection({
    builtInDefaultName: input.builtInDefaultName,
    candidates: input.records.map((record) => ({
      builtInDefault:
        input.builtInDefaultName !== undefined &&
        record.origin === "builtIn" &&
        record.entry.name === input.builtInDefaultName,
      featureId: record.featureId,
      kind: input.kind,
      name: record.entry.name,
      origin: record.origin,
      value: record.entry.value,
    })),
    kind: input.kind,
  });
};

const makeRuntimeSelections = (input: {
  readonly options: FeatureBootOptions;
  readonly registered: RegisteredFeatureContributions;
}): RuntimeSelections => {
  const availableHarnessNames = new Set(input.options.availableHarnessNames);
  const harness = resolveProviderSelection({
    builtInDefaultName: input.options.builtInDefaultHarnessName,
    builtInDefaultPriority: input.options.builtInDefaultHarnessPriority,
    candidates: input.registered.harnesses.records.map((record) => ({
      builtInDefault:
        input.options.builtInDefaultHarnessName !== undefined &&
        record.origin === "builtIn" &&
        record.entry.name === input.options.builtInDefaultHarnessName,
      featureId: record.featureId,
      kind: "harness",
      name: record.entry.name,
      origin: record.origin,
      value: record.entry,
    })),
    isBuiltInAvailable:
      input.options.availableHarnessNames === undefined
        ? undefined
        : (name): boolean => availableHarnessNames.has(name),
    kind: "harness",
  });
  const db = resolveNamedProviderSelection({
    builtInDefaultName: input.options.builtInDefaultDbName,
    kind: "db",
    records: input.registered.dbs.records,
  });
  const diagnostics = [...harness.diagnostics, ...db.diagnostics];
  const warnings = [...harness.warnings, ...db.warnings];

  return {
    db,
    diagnostics,
    harness,
    warnings,
  };
};

const makeRuntimeProviderSet = (
  registries: StaticRegistrySet
): RuntimeProviderSet => ({ ...registries });

const makeRuntimeGraph = (
  definition: FeatureDefinition,
  selections: RuntimeSelections
): RuntimeGraph => ({
  close: (): Effect.Effect<void> =>
    Effect.all(
      definition.harnesses.map((harness) => harness.close.pipe(Effect.ignore)),
      {
        concurrency: "unbounded",
        discard: true,
      }
    ),
  definition,
  providers: makeRuntimeProviderSet(definition.registries),
  selections,
});

const makeFeatureDefinition = Effect.fn("FeatureBoot.makeFeatureDefinition")(
  function* (
    input: {
      readonly dependencyPlan: FeatureDependencyPlan;
      readonly diagnosticRecords: readonly BootDiagnostic[];
      readonly features: readonly ResolvedFeature[];
      readonly imported: ImportedFeatureContributions;
      readonly options: FeatureBootOptions;
      readonly registered: RegisteredFeatureContributions;
      readonly runEffect: <Value, Error>(
        effect: Effect.Effect<Value, Error>
      ) => Promise<Value>;
      readonly runtimeContext?: Context.Context<never>;
      readonly invoke: () => AgentInvokeStream | undefined;
    },
    selections: RuntimeSelections
  ) {
    const harnesses = input.registered.harnesses.entries;
    const promptEntries = input.registered.prompts.entries;
    const skillEntries = input.registered.skills.entries;
    const modelProviders = input.registered.modelProviders.entries;
    const apiEntries = input.registered.apis.entries;
    const capabilityFields = makeCapabilityBootFields({
      registered: input.registered,
    });
    const registries = makeStaticRegistrySet({
      apiEntries,
      capabilityFields,
      harnesses,
      modelProviders,
      promptEntries,
      runEffect: input.runEffect,
      selections,
      skillEntries,
    });
    const hookRegistry = yield* makeFeatureHookRegistry({
      apiEntries,
      dependencyPlan: input.dependencyPlan,
      registered: input.registered,
      registries,
      invoke: input.invoke,
      runtimeContext: input.runtimeContext ?? Context.empty(),
    });
    const allRegistries = {
      ...registries,
      hookRegistry,
    };
    const { diagnostics, structuredDiagnostics, warnings } =
      makeBootDiagnostics(
        [...input.diagnosticRecords, ...hookRegistry.diagnostics],
        selections
      );

    return assembleFeatureDefinition({
      apiEntries,
      capabilityFields,
      diagnostics,
      harnesses,
      input,
      modelProviders,
      promptEntries,
      registries: allRegistries,
      skillEntries,
      structuredDiagnostics,
      warnings,
    });
  }
);

export const makeFeatureBootResult = Effect.fn(
  "FeatureBoot.makeFeatureBootResult"
)(function* (input: {
  readonly dependencyPlan: FeatureDependencyPlan;
  readonly diagnosticRecords: readonly BootDiagnostic[];
  readonly features: readonly ResolvedFeature[];
  readonly imported: ImportedFeatureContributions;
  readonly options: FeatureBootOptions;
  readonly registered: RegisteredFeatureContributions;
  readonly runEffect: <Value, Error>(
    effect: Effect.Effect<Value, Error>
  ) => Promise<Value>;
  readonly runtimeContext?: Context.Context<never>;
  /**
   * Late-bound reader for the daemon's agent `invoke`, supplied by the
   * composition root that owns the `AgentInvokeCell`. Boot always runs
   * before a schedule runtime exists, so this reads `undefined` here and only
   * resolves once a hook handler actually fires.
   */
  readonly invoke: () => AgentInvokeStream | undefined;
}) {
  const selections = makeRuntimeSelections(input);
  const definition = yield* makeFeatureDefinition(input, selections);
  const runtimeGraph = makeRuntimeGraph(definition, selections);

  return {
    ...definition,
    ...definition.registries,
    definition,
    runtimeGraph,
  };
});
