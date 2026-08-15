import { Effect, Path } from "effect";

import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type { ImportedRootPersonaContributions } from "../contributions/root-persona.ts";
import type { ImportedFeatureContributions } from "./contributions.ts";
import type { BootDiagnostic } from "./diagnostic-types.ts";
import type { FeatureBootOptions } from "./options.ts";

import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import { resolveFeatureDependencyPlan } from "../../../../engine/features/src/dependency-plan.ts";
import { discoverFeatures } from "../../../../engine/features/src/feature-loader.ts";
import { makeSkillRegistry } from "../../../../engine/registries/src/skill.ts";
import { AgentInvokeCell } from "../agent/invoke-cell.ts";
import { importRootPersonaContributions } from "../contributions/root-persona.ts";
import {
  formatBootDiagnostic,
  makeBootDiagnosticRecords,
} from "./diagnostics.ts";
import { importFeatureContributions } from "./import.ts";
import { registerFeatureContributions } from "./registration.ts";
import { makeFeatureBootResult } from "./result.ts";

const withPreferredHarness = (
  options: FeatureBootOptions,
  preferred: string | undefined
): FeatureBootOptions => {
  const bundled = options.builtInDefaultHarnessPriority;
  if (preferred === undefined || bundled === undefined) {
    return options;
  }
  const preferredName = HarnessName.make(preferred);
  return {
    ...options,
    builtInDefaultHarnessPriority: [
      preferredName,
      ...bundled.filter((name) => name !== preferredName),
    ],
  };
};

// Merge the root-persona records ahead of the feature records. Prompt entries are
// aggregate and composed by `order`, so leading placement plus the persona's low
// default order keeps it first. Model registration is single-provider and
// last-shadow-wins, so placing the persona's `model` record FIRST lets an explicit
// `features/model` (registered later) override it, while both still override the
// built-in default (RFC 0002 root-persona.md).
const mergeRootPersonaContributions = (
  feature: ImportedFeatureContributions,
  rootPersona: ImportedRootPersonaContributions
): ImportedFeatureContributions => {
  const promptRecords = [
    ...rootPersona.prompts.records,
    ...feature.prompts.records,
  ];
  const modelRecords = [
    ...rootPersona.modelProviders.records,
    ...feature.modelProviders.records,
  ];
  return {
    ...feature,
    modelProviders: {
      diagnostics: [
        ...rootPersona.modelProviders.diagnostics,
        ...feature.modelProviders.diagnostics,
      ],
      entries: modelRecords.map((record) => record.entry),
      records: modelRecords,
    },
    prompts: {
      diagnostics: [
        ...rootPersona.prompts.diagnostics,
        ...feature.prompts.diagnostics,
      ],
      entries: promptRecords.map((record) => record.entry),
      records: promptRecords,
    },
  };
};

const formatFeatureBootDiagnostics = (diagnostics: readonly string[]): string =>
  diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n");

const formatStructuredFeatureBootDiagnostics = (
  diagnostics: readonly BootDiagnostic[]
): string =>
  diagnostics
    .filter((diagnostic) => diagnostic.level !== "info")
    .map((diagnostic) => `- ${formatBootDiagnostic(diagnostic)}`)
    .join("\n");

const selectFeaturesForImport = (
  orderedFeatures: readonly ResolvedFeature[],
  reload: FeatureBootOptions["reload"]
): readonly ResolvedFeature[] => {
  if (
    reload?.affectedFeatureIds === undefined ||
    reload.previousImported === undefined
  ) {
    return orderedFeatures;
  }

  const affected = new Set(reload.affectedFeatureIds);
  return orderedFeatures.filter((feature) => affected.has(feature.id));
};

const makeReloadImportMergeContext = (input: {
  readonly affectedFeatureIds: readonly string[];
  readonly orderedFeatures: readonly ResolvedFeature[];
}): {
  affected: Set<string>;
  enabled: Set<string>;
  order: Map<string, number>;
} => ({
  affected: new Set(input.affectedFeatureIds),
  enabled: new Set(input.orderedFeatures.map((feature) => feature.id)),
  order: new Map(
    input.orderedFeatures.map((feature, index) => [feature.id, index])
  ),
});

interface ImportedRecord<Entry> {
  readonly entry: Entry;
  readonly featureId: string;
}

interface ImportedRecordSet<Entry, Record extends ImportedRecord<Entry>> {
  readonly diagnostics: readonly BootDiagnostic[];
  readonly entries: readonly Entry[];
  readonly records: readonly Record[];
}

const orderImportedRecords = <Record extends ImportedRecord<unknown>>(
  records: readonly Record[],
  order: ReadonlyMap<string, number>
): readonly Record[] =>
  records
    .map((record, index) => ({
      index,
      record,
    }))
    .toSorted(
      (left, right) =>
        (order.get(left.record.featureId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.record.featureId) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index
    )
    .map(({ record }) => record);

const mergeImportedRecords = <Entry, Record extends ImportedRecord<Entry>>(
  previous: ImportedRecordSet<Entry, Record>,
  fresh: ImportedRecordSet<Entry, Record>,
  context: {
    readonly affected: ReadonlySet<string>;
    readonly diagnostics: readonly BootDiagnostic[];
    readonly enabled: ReadonlySet<string>;
    readonly order: ReadonlyMap<string, number>;
  }
): ImportedRecordSet<Entry, Record> => {
  const records = orderImportedRecords(
    [
      ...previous.records.filter(
        (record) =>
          context.enabled.has(record.featureId) &&
          !context.affected.has(record.featureId)
      ),
      ...fresh.records.filter((record) =>
        context.enabled.has(record.featureId)
      ),
    ],
    context.order
  );
  return {
    diagnostics: context.diagnostics,
    entries: records.map((record) => record.entry),
    records,
  };
};

const mergeReloadImportedContributions = (input: {
  readonly affectedFeatureIds: readonly string[];
  readonly fresh: ImportedFeatureContributions;
  readonly orderedFeatures: readonly ResolvedFeature[];
  readonly previous: ImportedFeatureContributions;
}): ImportedFeatureContributions => {
  const context = makeReloadImportMergeContext(input);
  const previousHooks = input.previous.hooks;
  const freshHooks = input.fresh.hooks;
  // Every kind merges identically: previous ⊕ fresh under the shared reload
  // context, carrying the fresh side's diagnostics. `merge` captures that so a
  // new kind is one line, not a six-line block. Each call binds the generic from
  // its own concrete record sets, so no per-kind type annotation is needed.
  const merge = <Entry, Record extends ImportedRecord<Entry>>(
    previous: ImportedRecordSet<Entry, Record>,
    fresh: ImportedRecordSet<Entry, Record>
  ): ImportedRecordSet<Entry, Record> =>
    mergeImportedRecords(previous, fresh, {
      ...context,
      diagnostics: fresh.diagnostics,
    });

  const skills = merge(input.previous.skills, input.fresh.skills);

  return {
    apis: merge(input.previous.apis, input.fresh.apis),
    ...(previousHooks !== undefined && freshHooks !== undefined
      ? { hooks: merge(previousHooks, freshHooks) }
      : {}),
    chats: merge(input.previous.chats, input.fresh.chats),
    commands: merge(input.previous.commands, input.fresh.commands),
    dbs: merge(input.previous.dbs, input.fresh.dbs),
    harnesses: merge(input.previous.harnesses, input.fresh.harnesses),
    modelProviders: merge(
      input.previous.modelProviders,
      input.fresh.modelProviders
    ),
    prompts: merge(input.previous.prompts, input.fresh.prompts),
    schedules: merge(input.previous.schedules, input.fresh.schedules),
    skills: {
      ...skills,
      registry: makeSkillRegistry(skills.entries),
    },
  };
};

const importReloadAwareFeatureContributions = Effect.fn(
  "FeatureBoot.importReloadAwareContributions"
)(function* (
  featuresRoot: string,
  orderedFeatures: readonly ResolvedFeature[],
  reload: FeatureBootOptions["reload"]
) {
  const featuresToImport = selectFeaturesForImport(orderedFeatures, reload);
  const fresh = yield* importFeatureContributions(
    featuresRoot,
    featuresToImport
  );
  if (
    reload?.affectedFeatureIds === undefined ||
    reload.previousImported === undefined
  ) {
    return fresh;
  }

  return mergeReloadImportedContributions({
    affectedFeatureIds: reload.affectedFeatureIds,
    fresh,
    orderedFeatures,
    previous: reload.previousImported,
  });
});

/**
 * Run the first production boot slice for an RouteKitEval feature tree.
 *
 * This gives the runtime one coherent seam for RFC 0003 boot work: discovery,
 * dependency DAG, import/validation, registry registration, prompt assembly
 * inputs, skill/API registries, and diagnostics.
 */
export const bootFeatureProject = Effect.fn("FeatureBoot.bootProject")(
  function* (options: FeatureBootOptions) {
    const context = yield* Effect.context();
    const discovered = yield* discoverFeatures(options.featuresRoot, {
      affectedFeatureIds: options.reload?.affectedFeatureIds,
      previousFeatures: options.reload?.previousFeatures,
    });
    const { features } = discovered;
    const dependencyPlan = yield* resolveFeatureDependencyPlan(
      options.featuresRoot,
      features,
      {
        affectedFeatureIds: options.reload?.affectedFeatureIds,
        previousPackageInfos: options.reload?.previousPackageInfos,
      }
    );
    const featureImported = yield* importReloadAwareFeatureContributions(
      options.featuresRoot,
      dependencyPlan.enabledFeatures,
      options.reload
    );
    // The root-persona `routekit-eval.md` (RFC 0002 root-persona.md) is not a `features/*` entry, so it is
    // read on every boot (outside the reload-merge, which is keyed by feature id) and
    // merged in here. Re-reading a single root file each boot is cheap and keeps the
    // persona present across incremental reloads.
    const path = yield* Path.Path;
    const workspaceRoot =
      options.workspaceRoot ?? path.dirname(options.featuresRoot);
    const rootPersona = yield* importRootPersonaContributions(workspaceRoot);
    const imported = mergeRootPersonaContributions(
      featureImported,
      rootPersona
    );
    // Layer the `routekit-eval.md` `harness` preference (if any) ahead of the bundled harness
    // priority order so optimistic selection tries the workspace's preferred harness
    // first, then falls back through the remaining built-ins by availability (RFC 0006).
    const selectionOptions = withPreferredHarness(
      options,
      rootPersona.preferredHarnessName
    );
    const registered = registerFeatureContributions(
      selectionOptions,
      imported,
      dependencyPlan.enabledFeatures.map((feature) => feature.id)
    );
    const diagnosticRecords = makeBootDiagnosticRecords({
      dependencyDiagnostics: dependencyPlan.diagnostics,
      features,
      featureLoaderWarnings: discovered.warnings,
      imported,
      options: selectionOptions,
      registered,
    });
    const agentInvoke = yield* AgentInvokeCell;
    return yield* makeFeatureBootResult({
      dependencyPlan,
      diagnosticRecords,
      features,
      imported,
      invoke: agentInvoke.read,
      options: selectionOptions,
      registered,
      runtimeContext: context,
      runEffect: Effect.runPromiseWith(context),
    });
  }
);

export { formatFeatureBootDiagnostics, formatStructuredFeatureBootDiagnostics };
