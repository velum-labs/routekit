import type { Effect as EffectType } from "effect";

import { Effect } from "effect";

import type {
  ChatContribution,
  CommandContribution,
  ScheduleDefinition,
  StateStoreContribution,
} from "../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { NamedContributionEntry } from "./capability-entries.ts";

import { RegistryError } from "../../../contracts/internal/src/errors.ts";
import { makeRegistryLookup } from "./registry.ts";
import {
  formatProviderSelectionFailure,
  resolveProviderSelection,
} from "../../../utils/core/src/provider-selection.ts";

export interface NamedContributionRegistryShape<Value> {
  readonly default: EffectType.Effect<Value, RegistryError>;
  readonly entries: readonly NamedContributionEntry<Value>[];
  readonly getEntry: (
    name: string
  ) => EffectType.Effect<NamedContributionEntry<Value>, RegistryError>;
  readonly get: (name: string) => EffectType.Effect<Value, RegistryError>;
}

export interface AggregateContributionRegistryShape<Entry> {
  readonly entries: readonly Entry[];
}

export interface NamedAggregateContributionRegistryShape<
  Value,
> extends AggregateContributionRegistryShape<NamedContributionEntry<Value>> {
  readonly getEntry: (
    name: string
  ) => EffectType.Effect<NamedContributionEntry<Value>, RegistryError>;
  readonly get: (name: string) => EffectType.Effect<Value, RegistryError>;
}

const makeNamedEntryLookup = <Value>(
  kind: string,
  entries: readonly NamedContributionEntry<Value>[]
): ((
  name: string
) => EffectType.Effect<NamedContributionEntry<Value>, RegistryError>) => {
  const byName = new Map(entries.map((entry) => [entry.name, entry] as const));
  return (name) => {
    const entry = byName.get(name);
    return entry === undefined
      ? new RegistryError({
          kind,
          name,
        })
      : Effect.succeed(entry);
  };
};

export const makeProviderContributionRegistry = <Value>(
  kind: string,
  entries: readonly NamedContributionEntry<Value>[],
  defaultName?: string
): NamedContributionRegistryShape<Value> => {
  const registry = makeRegistryLookup<Value>({
    entries: entries.map((entry) => ({
      name: entry.name,
      value: entry.value,
    })),
    kind,
  });
  // Origin-aware selection (RFC 0003 §Default selection, tiers 1-5) runs
  // upstream in the boot path (`resolveNamedProviderSelection` in
  // feature-boot-result.ts), which maps each entry's real `origin` and hands the
  // winner here as `defaultName`. So the production callers always pass
  // `defaultName` and this branch is skipped. It only runs when no upstream
  // selection was made (empty entries, or the test-support registry that omits
  // `defaultName`).
  //
  // Stamping every candidate `origin: "project"` in that fallback is safe — it
  // can never *misselect* — because `NamedContributionEntry` carries neither an
  // `origin` nor a `projectDefault` field. Walk the tiers for each entry count:
  //   - 0 entries → no-default failure, regardless of origin.
  //   - 1 entry   → the sole-entry tier (tier 4) selects it, regardless of origin.
  //   - ≥2 entries→ no candidate carries `projectDefault`, so tier 3's flagged
  //     path is empty; the sole-project-entry sub-tier then sees >1 project
  //     candidate and returns an *ambiguous-default* `RegistryError` (pinned by
  //     `checksAmbiguousProviderRegistry` in capability.test.ts). That is a
  //     fail-loud error, not a silent wrong pick.
  // The origin stamp cannot fabricate a built-in-vs-project *win* here because
  // the only origin-sensitive tier that could (tier 3's `projectDefault` flag)
  // requires a field these entries never have. If a future entry type does carry
  // origin/`projectDefault`, thread the real origin through instead of stamping.
  const selection =
    defaultName === undefined
      ? resolveProviderSelection({
          candidates: entries.map((entry) => ({
            featureId: entry.featureId,
            kind,
            name: entry.name,
            origin: "project",
            value: entry.value,
          })),
          kind,
        })
      : undefined;
  const selectedName = defaultName ?? selection?.selected?.name;
  const getEntry = makeNamedEntryLookup(kind, entries);

  return {
    default:
      selectedName === undefined
        ? new RegistryError({
            detail: formatProviderSelectionFailure(kind, selection),
            kind,
            name: "default",
          })
        : registry.get(selectedName),
    entries,
    getEntry,
    get: registry.get,
  };
};

export const makeAggregateContributionRegistry = <Entry>(
  entries: readonly Entry[]
): AggregateContributionRegistryShape<Entry> => ({ entries });

export const makeNamedAggregateContributionRegistry = <Value>(
  kind: string,
  entries: readonly NamedContributionEntry<Value>[]
): NamedAggregateContributionRegistryShape<Value> => {
  const registry = makeRegistryLookup<Value>({
    entries: entries.map((entry) => ({
      name: entry.name,
      value: entry.value,
    })),
    kind,
  });
  const getEntry = makeNamedEntryLookup(kind, entries);

  return {
    entries,
    getEntry,
    get: registry.get,
  };
};

export type DbRegistryShape =
  NamedContributionRegistryShape<StateStoreContribution>;
export type ChatRegistryShape =
  NamedAggregateContributionRegistryShape<ChatContribution>;
export type ScheduleRegistryShape =
  NamedAggregateContributionRegistryShape<ScheduleDefinition>;
export type CommandRegistryShape =
  NamedAggregateContributionRegistryShape<CommandContribution>;
