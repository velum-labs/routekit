import type { Effect } from "effect";

import type { ChatSuggestion } from "../../../../contracts/author/src/chat.ts";
import type { StateStoreContribution } from "../../../../contracts/internal/src/author-schemas/capability-schemas.ts";
import type { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import type { FeaturePackageInfo } from "../../../../engine/features/src/dependency-types.ts";
import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type { HarnessRegistryShape } from "../../../../engine/harness/src/registry.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { ApiRegistryShape } from "../../../../engine/registries/src/api.ts";
import type {
  ChatRegistryShape,
  CommandRegistryShape,
  DbRegistryShape,
  ScheduleRegistryShape,
} from "../../../../engine/registries/src/capability.ts";
import type { ModelRegistryShape } from "../../../../engine/registries/src/model.ts";
import type { PromptRegistryShape } from "../../../../engine/registries/src/prompt.ts";
import type { SkillRegistryShape } from "../../../../engine/registries/src/skill.ts";
import type {
  ImportedFeatureContributions,
  RegisteredFeatureContributions,
} from "./contributions.ts";
import type { BootDiagnostic } from "./diagnostic-types.ts";
import type { HookRegistryShape } from "../hooks/registry.ts";
import type {
  ProviderSelectionDiagnostic,
  ProviderSelectionResult,
} from "../../../../utils/core/src/provider-selection-support.ts";

export interface StaticRegistrySet {
  readonly apiRegistry: ApiRegistryShape;
  readonly hookRegistry?: HookRegistryShape;
  readonly chatRegistry: ChatRegistryShape;
  readonly commandRegistry: CommandRegistryShape;
  readonly dbRegistry: DbRegistryShape;
  readonly harnessRegistry: HarnessRegistryShape;
  readonly modelRegistry: ModelRegistryShape;
  readonly promptRegistry: PromptRegistryShape;
  readonly scheduleRegistry: ScheduleRegistryShape;
  readonly skillRegistry: SkillRegistryShape;
}

export interface FeatureDefinition {
  readonly builtInCodeSkillSuggestions: readonly ChatSuggestion[];
  readonly apiEntries: RegisteredFeatureContributions["apis"]["entries"];
  readonly bootOrder: readonly string[];
  readonly chatEntries: RegisteredFeatureContributions["chats"]["entries"];
  readonly commandEntries: RegisteredFeatureContributions["commands"]["entries"];
  readonly dbEntries: RegisteredFeatureContributions["dbs"]["entries"];
  readonly dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly diagnostics: readonly string[];
  readonly enabledFeatures: readonly ResolvedFeature[];
  readonly features: readonly ResolvedFeature[];
  readonly harnesses: readonly RuntimeHarness[];
  readonly imported: ImportedFeatureContributions;
  readonly modelProviders: RegisteredFeatureContributions["modelProviders"]["entries"];
  readonly packageInfos: readonly FeaturePackageInfo[];
  readonly promptEntries: RegisteredFeatureContributions["prompts"]["entries"];
  readonly registered: RegisteredFeatureContributions;
  readonly registries: StaticRegistrySet;
  readonly scheduleEntries: RegisteredFeatureContributions["schedules"]["entries"];
  readonly skillEntries: RegisteredFeatureContributions["skills"]["entries"];
  readonly structuredDiagnostics: readonly BootDiagnostic[];
  readonly valid: boolean;
  readonly warnings: readonly string[];
}

export interface RuntimeSelections {
  readonly db: ProviderSelectionResult<StateStoreContribution>;
  readonly diagnostics: readonly ProviderSelectionDiagnostic[];
  readonly harness: ProviderSelectionResult<RuntimeHarness, HarnessName>;
  readonly warnings: readonly ProviderSelectionDiagnostic[];
}

export type RuntimeProviderSet = StaticRegistrySet;

export interface RuntimeGraph {
  /**
   * No-op until runtime acquisition owns scoped resources; future PRs will
   * release opened stores, mounted surfaces, and controllers here.
   */
  readonly close: () => Effect.Effect<void>;
  readonly definition: FeatureDefinition;
  readonly providers: RuntimeProviderSet;
  readonly selections: RuntimeSelections;
}

export interface FeatureBootResult
  extends FeatureDefinition, StaticRegistrySet {
  readonly definition: FeatureDefinition;
  readonly runtimeGraph: RuntimeGraph;
}
