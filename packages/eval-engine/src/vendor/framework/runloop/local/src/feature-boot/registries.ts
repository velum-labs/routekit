import { Effect } from "effect";

import type { ApiRegistryRunEffect } from "../../../../engine/registries/src/api.ts";
import type { RegisteredFeatureContributions } from "./contributions.ts";
import type {
  RuntimeSelections,
  StaticRegistrySet,
} from "./types.ts";
import type { ProviderSelectionResult } from "../../../../utils/core/src/provider-selection-support.ts";

import { RegistryError } from "../../../../contracts/internal/src/errors.ts";
import { makeHarnessRegistry } from "../../../../engine/harness/src/registry.ts";
import { makeApiRegistry } from "../../../../engine/registries/src/api.ts";
import {
  makeNamedAggregateContributionRegistry,
  makeProviderContributionRegistry,
} from "../../../../engine/registries/src/capability.ts";
import { makeModelRegistry } from "../../../../engine/registries/src/model.ts";
import { makePromptRegistry } from "../../../../engine/registries/src/prompt.ts";
import { makeSkillRegistry } from "../../../../engine/registries/src/skill.ts";
import { formatProviderSelectionFailure } from "../../../../utils/core/src/provider-selection.ts";

interface CapabilityBootFields {
  readonly chatEntries: RegisteredFeatureContributions["chats"]["entries"];
  readonly commandEntries: RegisteredFeatureContributions["commands"]["entries"];
  readonly dbEntries: RegisteredFeatureContributions["dbs"]["entries"];
  readonly scheduleEntries: RegisteredFeatureContributions["schedules"]["entries"];
}

const makeCapabilityBootFields = (input: {
  readonly registered: RegisteredFeatureContributions;
}): CapabilityBootFields => {
  const { registered } = input;

  return {
    chatEntries: registered.chats.entries,
    commandEntries: registered.commands.entries,
    dbEntries: registered.dbs.entries,
    scheduleEntries: registered.schedules.entries,
  };
};

const makeProviderDefaultEffect = <Value, Name extends string>(
  kind: string,
  selection: ProviderSelectionResult<Value, Name>
): Effect.Effect<Value, RegistryError> => {
  if (selection.selected !== undefined) {
    return Effect.succeed(selection.selected.value);
  }

  return new RegistryError({
    detail: formatProviderSelectionFailure(kind, selection),
    kind,
    name: "default",
  });
};

export const makeStaticRegistrySet = (input: {
  readonly apiEntries: RegisteredFeatureContributions["apis"]["entries"];
  readonly capabilityFields: CapabilityBootFields;
  readonly harnesses: RegisteredFeatureContributions["harnesses"]["entries"];
  readonly modelProviders: RegisteredFeatureContributions["modelProviders"]["entries"];
  readonly promptEntries: RegisteredFeatureContributions["prompts"]["entries"];
  readonly runEffect: ApiRegistryRunEffect;
  readonly selections: RuntimeSelections;
  readonly skillEntries: RegisteredFeatureContributions["skills"]["entries"];
}): StaticRegistrySet => ({
  apiRegistry: makeApiRegistry(input.apiEntries, input.runEffect),
  chatRegistry: makeNamedAggregateContributionRegistry(
    "chat",
    input.capabilityFields.chatEntries
  ),
  commandRegistry: makeNamedAggregateContributionRegistry(
    "command",
    input.capabilityFields.commandEntries
  ),
  dbRegistry: makeProviderContributionRegistry(
    "db",
    input.capabilityFields.dbEntries,
    input.selections.db.selected?.name
  ),
  harnessRegistry: makeHarnessRegistry(
    input.harnesses,
    makeProviderDefaultEffect("harness", input.selections.harness)
  ),
  modelRegistry: makeModelRegistry(input.modelProviders),
  promptRegistry: makePromptRegistry(input.promptEntries),
  scheduleRegistry: makeNamedAggregateContributionRegistry(
    "schedule",
    input.capabilityFields.scheduleEntries
  ),
  skillRegistry: makeSkillRegistry(input.skillEntries),
});

export { makeCapabilityBootFields };
export type { CapabilityBootFields };
