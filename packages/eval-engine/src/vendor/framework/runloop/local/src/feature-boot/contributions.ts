import type { ApiRegistryEntry } from "../../../../contracts/internal/src/author-schemas/api.ts";
import type {
  ChatContribution,
  CommandContribution,
  ScheduleDefinition,
  StateStoreContribution,
} from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { ModelRegistryEntry } from "../../../../contracts/internal/src/author-schemas/model.ts";
import type { PromptRegistryEntry } from "../../../../contracts/internal/src/author-schemas/prompt.ts";
import type { SkillRegistryEntry } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";
import type { SkillRegistryShape } from "../../../../engine/registries/src/skill.ts";
import type { HooksRegistryEntry } from "../contributions/hooks.ts";
import type {
  ContributionSet,
  ImportedContribution,
} from "../contributions/imported-contribution.ts";
import type { BuiltInShadowPlan } from "./built-in-shadow.ts";

export type { ContributionSet } from "../contributions/imported-contribution.ts";

export type ImportedNamedContributions<Value> = ContributionSet<
  NamedContributionEntry<Value>
>;

export type ImportedApiContributions = ContributionSet<ApiRegistryEntry>;
export type ImportedModelContributions = ContributionSet<ModelRegistryEntry>;
export type ImportedHarnesses = ContributionSet<RuntimeHarness>;
export type ImportedPromptContributions = ContributionSet<PromptRegistryEntry>;

export interface ImportedSkillContributions extends ContributionSet<SkillRegistryEntry> {
  readonly registry: SkillRegistryShape;
}

export type RegisteredContributions<Entry> = ContributionSet<Entry>;

export interface ImportedFeatureContributions {
  readonly apis: ImportedApiContributions;
  readonly hooks?: ContributionSet<HooksRegistryEntry>;
  readonly chats: ImportedNamedContributions<ChatContribution>;
  readonly commands: ImportedNamedContributions<CommandContribution>;
  readonly dbs: ImportedNamedContributions<StateStoreContribution>;
  readonly harnesses: ImportedHarnesses;
  readonly modelProviders: ImportedModelContributions;
  readonly prompts: ImportedPromptContributions;
  readonly schedules: ImportedNamedContributions<ScheduleDefinition>;
  readonly skills: ImportedSkillContributions;
}

export interface RegisteredFeatureContributions {
  readonly apis: RegisteredContributions<ApiRegistryEntry>;
  /**
   * Which built-in features a project feature replaced this boot, and the kinds
   * each one lost. Diagnostics read it to explain a shadow, and to explain a
   * required contract that a shadow left unfilled.
   */
  readonly builtInShadow: BuiltInShadowPlan;
  readonly hooks?: RegisteredContributions<HooksRegistryEntry>;
  readonly chats: RegisteredContributions<
    NamedContributionEntry<ChatContribution>
  >;
  readonly commands: RegisteredContributions<
    NamedContributionEntry<CommandContribution>
  >;
  readonly dbs: RegisteredContributions<
    NamedContributionEntry<StateStoreContribution>
  >;
  readonly harnesses: RegisteredContributions<RuntimeHarness>;
  readonly modelProviders: RegisteredContributions<ModelRegistryEntry>;
  readonly prompts: RegisteredContributions<PromptRegistryEntry>;
  readonly schedules: RegisteredContributions<
    NamedContributionEntry<ScheduleDefinition>
  >;
  readonly skills: RegisteredContributions<SkillRegistryEntry>;
}

export type ImportedAnyContribution<Entry> = ImportedContribution<Entry>;
