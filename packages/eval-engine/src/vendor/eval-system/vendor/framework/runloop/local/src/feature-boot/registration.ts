import type { ApiRegistryEntry } from "../../../../contracts/internal/src/author-schemas/api.ts";
import type { SkillRegistryEntry } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { HooksRegistryEntry } from "../contributions/hooks.ts";
import type { ImportedContribution } from "../contributions/imported-contribution.ts";
import type { BuiltInShadowPlan } from "./built-in-shadow.ts";
import type {
  ImportedFeatureContributions,
  RegisteredContributions,
  RegisteredFeatureContributions,
} from "./contributions.ts";
import type { FeatureBootOptions } from "./options.ts";

import { parseRouteKey } from "../../../../contracts/internal/src/author-schemas/api.ts";
import { planBuiltInShadowing } from "./built-in-shadow.ts";
import {
  makeContributionBootDiagnostic,
  makeRegistryBootDiagnostic,
} from "./diagnostic-record.ts";
import { EXTERNAL_SKILLS_FEATURE_ID } from "../skills/external-config.ts";

interface NamedEntry {
  readonly name: string;
}

const upsertRecord = <Entry>(input: {
  readonly indexes: Map<string, number>;
  readonly name: string;
  readonly record: ImportedContribution<Entry>;
  readonly records: ImportedContribution<Entry>[];
}): void => {
  const existingIndex = input.indexes.get(input.name);
  if (existingIndex === undefined) {
    input.indexes.set(input.name, input.records.length);
    input.records.push(input.record);
    return;
  }
  input.records[existingIndex] = input.record;
};

const registerContributions = <Entry>(input: {
  readonly getName: (entry: Entry) => string;
  readonly kind: string;
  readonly projectEntries: readonly ImportedContribution<Entry>[];
}): RegisteredContributions<Entry> => {
  const diagnostics: RegisteredContributions<Entry>["diagnostics"][number][] =
    [];
  const entries: Entry[] = [];
  const records: ImportedContribution<Entry>[] = [];
  const seen = new Map<string, number>();
  const recordIndexes = new Map<string, number>();

  for (const record of input.projectEntries) {
    const name = input.getName(record.entry);
    const existingIndex = seen.get(name);
    if (existingIndex !== undefined) {
      if (record.shadows) {
        entries[existingIndex] = record.entry;
        upsertRecord({
          indexes: recordIndexes,
          name,
          record,
          records,
        });
        continue;
      }
      diagnostics.push(
        makeRegistryBootDiagnostic({
          contributionName: input.kind,
          featureId: record.featureId,
          message: `${input.kind} "${name}" collides with an earlier entry and is disabled (feature "${record.featureId}")`,
        })
      );
      continue;
    }
    seen.set(name, entries.length);
    entries.push(record.entry);
    upsertRecord({
      indexes: recordIndexes,
      name,
      record,
      records,
    });
  }

  return {
    diagnostics,
    entries,
    records,
  };
};

const registerNamedContributions = <Entry extends NamedEntry>(
  kind: string,
  records: readonly ImportedContribution<Entry>[]
): RegisteredContributions<Entry> =>
  registerContributions({
    getName: (entry) => entry.name,
    kind,
    projectEntries: records,
  });

const filterSkillAliases = (
  entry: SkillRegistryEntry,
  takenNames: Set<string>,
  diagnostics: RegisteredFeatureContributions["skills"]["diagnostics"][number][]
): SkillRegistryEntry => {
  const aliases: string[] = [];
  for (const alias of entry.commandAliases ?? []) {
    if (takenNames.has(alias)) {
      diagnostics.push(
        makeContributionBootDiagnostic({
          code: "ROUTEKIT_EVAL_BOOT_REGISTRY_SKILL_ALIAS",
          contributionName: "skill",
          featureId: entry.featureId,
          level: "warning",
          message: `skill alias "${alias}" collides with an earlier entry and is disabled (feature "${entry.featureId}")`,
        })
      );
      continue;
    }
    takenNames.add(alias);
    aliases.push(alias);
  }
  const { commandAliases: _commandAliases, ...entryWithoutAliases } = entry;
  return aliases.length > 0
    ? {
        ...entryWithoutAliases,
        commandAliases: aliases,
      }
    : entryWithoutAliases;
};

const registerSkillContributions = (input: {
  readonly builtIns: readonly ImportedFeatureContributions["skills"]["records"][number][];
  readonly disabledNames: readonly string[];
  readonly project: readonly ImportedFeatureContributions["skills"]["records"][number][];
  readonly reservedNames: readonly string[];
  readonly warnings: readonly string[];
}): RegisteredFeatureContributions["skills"] => {
  const disabledNames = new Set(input.disabledNames);
  const project = input.project.filter(
    (record) => !disabledNames.has(record.entry.name)
  );
  const builtIns = input.builtIns.filter(
    (record) => !disabledNames.has(record.entry.name)
  );
  const projectSkillNames = new Set(project.map((record) => record.entry.name));
  const registered = registerNamedContributions("skill", [
    ...builtIns.filter((record) => !projectSkillNames.has(record.entry.name)),
    ...project,
  ]);
  const takenNames = new Set(input.reservedNames);
  for (const entry of registered.entries) {
    takenNames.add(entry.name);
  }
  const aliasDiagnostics: RegisteredFeatureContributions["skills"]["diagnostics"][number][] =
    [];
  const entries = registered.entries.map((entry) =>
    filterSkillAliases(entry, takenNames, aliasDiagnostics)
  );
  return {
    ...registered,
    entries,
    records: registered.records.map((record, index) => ({
      ...record,
      entry: entries[index] ?? record.entry,
    })),
    diagnostics: [
      ...input.warnings.map((message) =>
        makeContributionBootDiagnostic({
          code: "ROUTEKIT_EVAL_BOOT_IMPORT_SKILL",
          contributionName: "skill",
          featureId: EXTERNAL_SKILLS_FEATURE_ID,
          level: "warning",
          message,
        })
      ),
      ...registered.diagnostics,
      ...aliasDiagnostics,
    ],
  };
};

/**
 * Register `api` contributions (keyed by feature id), then resolve
 * inter-feature route collisions: every route is public at the daemon root
 * (RFC 0002 api.md), so two features declaring keys that normalize to the same
 * method+path conflict. The earlier registration (boot order) keeps the route;
 * the later feature's colliding route is reported and disabled — only that
 * route, never the whole feature (the `schedule` name-collision rule).
 */
const registerApiContributions = (
  records: readonly ImportedContribution<ApiRegistryEntry>[]
): RegisteredContributions<ApiRegistryEntry> => {
  const registered = registerContributions({
    getName: (entry) => entry.featureId,
    kind: "api",
    projectEntries: records,
  });

  const diagnostics = [...registered.diagnostics];
  const claimed = new Map<string, string>();
  const entries = registered.entries.map((entry) => {
    const { routes } = entry.api;
    if (routes === undefined) {
      return entry;
    }
    const kept: Record<string, NonNullable<typeof routes>[string]> = {};
    let dropped = false;
    for (const [key, handler] of Object.entries(routes)) {
      const parsed = parseRouteKey(key);
      // Malformed keys were already rejected by the contribution decode.
      const normalized = typeof parsed === "string" ? key : parsed.normalized;
      const owner = claimed.get(normalized);
      if (owner === undefined) {
        claimed.set(normalized, entry.featureId);
        kept[key] = handler;
        continue;
      }
      dropped = true;
      diagnostics.push(
        makeRegistryBootDiagnostic({
          contributionName: "api",
          featureId: entry.featureId,
          message: `api route "${key}" of feature "${entry.featureId}" collides with the same route from feature "${owner}" and is disabled`,
        })
      );
    }
    return dropped
      ? {
          ...entry,
          api: {
            ...entry.api,
            routes: kept,
          },
        }
      : entry;
  });

  return {
    diagnostics,
    entries,
    records: registered.records,
  };
};

/**
 * Every built-in record a shadow could remove. `hooks` is absent because there
 * is no `builtInHooks` option: hooks are project-only, so the hooks path below
 * skips `keepUnshadowed` for the same reason. A built-in hooks source would have
 * to be added in both places or it would quietly survive being shadowed.
 */
const builtInRecordsOf = (
  options: FeatureBootOptions
): readonly ImportedContribution<unknown>[] => [
  ...(options.builtInApis ?? []),
  ...(options.builtInChats ?? []),
  ...(options.builtInCommands ?? []),
  ...(options.builtInDbs ?? []),
  ...options.builtInHarnesses,
  ...(options.builtInModelProviders ?? []),
  ...(options.builtInPrompts ?? []),
  ...(options.builtInSchedules ?? []),
  ...(options.builtInSkills ?? []),
];

const keepUnshadowed = <Entry>(
  plan: BuiltInShadowPlan,
  records: readonly ImportedContribution<Entry>[] | undefined
): readonly ImportedContribution<Entry>[] =>
  (records ?? []).filter((record) => !plan.isShadowed(record));

/**
 * Register every contribution kind for one boot.
 *
 * Built-in feature shadowing runs first (RFC 0003
 * runtime-events-and-failure-policy.md): a project feature that took a built-in
 * feature's name removes that built-in's contributions from every kind before
 * any of them reach the per-kind merge, so the built-in is no longer present to
 * win a name collision against the feature that replaced it.
 *
 * `projectFeatureIds` are the enabled features' ids, which is deliberately not
 * derived from `imported` — a hollow feature contributes no records but still
 * shadows, and a feature that failed to import contributes none and must not.
 */
export const registerFeatureContributions = (
  options: FeatureBootOptions,
  imported: ImportedFeatureContributions,
  projectFeatureIds: readonly string[]
): RegisteredFeatureContributions => {
  const builtInShadow = planBuiltInShadowing({
    builtInRecords: builtInRecordsOf(options),
    projectFeatureIds,
  });
  const commands = registerNamedContributions("command", [
    ...keepUnshadowed(builtInShadow, options.builtInCommands),
    ...imported.commands.records,
  ]);

  return {
    apis: registerApiContributions([
      ...keepUnshadowed(builtInShadow, options.builtInApis),
      ...imported.apis.records,
    ]),
    builtInShadow,
    chats: registerNamedContributions("chat", [
      ...keepUnshadowed(builtInShadow, options.builtInChats),
      ...imported.chats.records,
    ]),
    commands,
    dbs: registerNamedContributions("db", [
      ...keepUnshadowed(builtInShadow, options.builtInDbs),
      ...imported.dbs.records,
    ]),
    harnesses: registerContributions({
      getName: (harness) => harness.name,
      kind: "harness",
      projectEntries: [
        ...keepUnshadowed(builtInShadow, options.builtInHarnesses),
        ...imported.harnesses.records,
      ],
    }),
    hooks: registerContributions<HooksRegistryEntry>({
      getName: (entry) => entry.featureId,
      kind: "hooks",
      projectEntries: imported.hooks?.records ?? [],
    }),
    modelProviders: registerNamedContributions("model", [
      ...keepUnshadowed(builtInShadow, options.builtInModelProviders),
      ...imported.modelProviders.records,
    ]),
    prompts: registerNamedContributions("prompt", [
      ...keepUnshadowed(builtInShadow, options.builtInPrompts),
      ...imported.prompts.records,
    ]),
    schedules: registerNamedContributions("schedule", [
      ...keepUnshadowed(builtInShadow, options.builtInSchedules),
      ...imported.schedules.records,
    ]),
    skills: registerSkillContributions({
      builtIns: keepUnshadowed(builtInShadow, options.builtInSkills),
      disabledNames: options.disabledSkillNames ?? [],
      project: imported.skills.records,
      reservedNames: commands.entries.map((entry) => entry.name),
      warnings: options.builtInSkillWarnings ?? [],
    }),
  };
};
