import type { Effect } from "effect";

import { Context } from "effect";

import type { ChatSuggestion } from "../../../../contracts/author/src/chat.ts";
import type { ApiRegistryEntry } from "../../../../contracts/internal/src/author-schemas/api.ts";
import type {
  ChatContribution,
  StateStoreContribution,
} from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { PromptRegistryEntry } from "../../../../contracts/internal/src/author-schemas/prompt.ts";
import type { SkillRegistryEntry } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { NamedContributionEntry } from "../../../../engine/registries/src/capability-entries.ts";
import type { ImportedContribution } from "../contributions/imported-contribution.ts";
import type { ImportedAnyContribution } from "../feature-boot/contributions.ts";

export type CatalogApiContribution = ImportedContribution<ApiRegistryEntry>;
export type CatalogChatContribution = ImportedContribution<
  NamedContributionEntry<ChatContribution>
>;
export type CatalogDbContribution = ImportedContribution<
  NamedContributionEntry<StateStoreContribution>
>;
export type CatalogHarnessContribution =
  ImportedAnyContribution<RuntimeHarness>;
export type CatalogPromptContribution =
  ImportedContribution<PromptRegistryEntry>;
export type CatalogSkillContribution = ImportedContribution<SkillRegistryEntry>;

export interface FeatureCatalogShape {
  readonly apis: readonly CatalogApiContribution[];
  readonly chats: readonly CatalogChatContribution[];
  readonly codeSkillSuggestions: readonly ChatSuggestion[];
  readonly dbs: readonly CatalogDbContribution[];
  readonly defaultDbName: string;
  readonly availableHarnessNames: readonly RuntimeHarness["name"][];
  readonly defaultHarnessName: RuntimeHarness["name"];
  readonly defaultHarnessPriority: readonly RuntimeHarness["name"][];
  readonly harnessDiagnostics: readonly string[];
  readonly harnesses: readonly CatalogHarnessContribution[];
  readonly prompts: readonly CatalogPromptContribution[];
  readonly skills: readonly CatalogSkillContribution[];
  readonly warnings: readonly string[];
  readonly disabledSkillNames: readonly string[];
  readonly workspaceSkillNames: readonly string[];
  readonly resolveWorkspaceSkills: (
    excludedNames: ReadonlySet<string>
  ) => Effect.Effect<readonly SkillRegistryEntry[], RuntimeServerError>;
  readonly authoringSkillName: string;
  readonly workspaceFeatureIds: readonly string[];
}

export class FeatureCatalog extends Context.Service<
  FeatureCatalog,
  FeatureCatalogShape
>()("ori/runtime/FeatureCatalog") {}
