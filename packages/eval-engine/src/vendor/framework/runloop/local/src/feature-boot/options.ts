import type { ChatSuggestion } from "../../../../contracts/author/src/chat.ts";
import type { FeaturePackageInfo } from "../../../../engine/features/src/dependency-types.ts";
import type { ResolvedFeature } from "../../../../engine/features/src/feature-loader-types.ts";
import type { RuntimeHarness } from "../../../../engine/harness/src/runtime-harness.ts";
import type { ImportedContribution } from "../contributions/imported-contribution.ts";
import type { ImportedFeatureContributions } from "./contributions.ts";

type HarnessName = RuntimeHarness["name"];
type ApiEntry =
  ImportedFeatureContributions["apis"]["records"][number]["entry"];
type ChatContribution =
  ImportedFeatureContributions["chats"]["records"][number]["entry"];
type CommandContribution =
  ImportedFeatureContributions["commands"]["records"][number]["entry"];
type ScheduleEntry =
  ImportedFeatureContributions["schedules"]["records"][number]["entry"];
type DbContribution =
  ImportedFeatureContributions["dbs"]["records"][number]["entry"];
type ModelContribution =
  ImportedFeatureContributions["modelProviders"]["records"][number]["entry"];
type PromptContribution =
  ImportedFeatureContributions["prompts"]["records"][number]["entry"];
type SkillContribution =
  ImportedFeatureContributions["skills"]["records"][number]["entry"];

export interface FeatureBootOptions {
  readonly builtInCodeSkillSuggestions?: readonly ChatSuggestion[];
  /**
   * Built-in `api` contributions (RFC 0002 api.md) registered ahead of the
   * workspace's own, keyed by feature id like any other api entry. The Slack
   * builtin's daemon-served routes arrive here.
   */
  readonly builtInApis?: readonly ImportedContribution<ApiEntry>[];
  readonly builtInChats?: readonly ImportedContribution<ChatContribution>[];
  readonly builtInCommands?: readonly ImportedContribution<CommandContribution>[];
  readonly builtInDbs?: readonly ImportedContribution<DbContribution>[];
  /**
   * Built-in harness names whose backing binary was detected at boot. Used as the
   * availability predicate for optimistic harness selection (RFC 0006).
   */
  readonly availableHarnessNames?: readonly HarnessName[];
  readonly builtInDefaultDbName?: string;
  readonly builtInDefaultHarnessName?: HarnessName;
  /**
   * Built-in harness priority order, highest first (RFC 0006). When set, harness
   * default selection walks this list (after layering any `ori.md` preference and
   * `availableHarnessNames` ahead of it) and picks the first available entry.
   */
  readonly builtInDefaultHarnessPriority?: readonly HarnessName[];
  readonly builtInHarnessDiagnostics?: readonly string[];
  readonly builtInHarnesses: readonly ImportedContribution<RuntimeHarness>[];
  readonly builtInModelProviders?: readonly ImportedContribution<ModelContribution>[];
  /**
   * Built-in prompt fragments merged ahead of the workspace's own prompt
   * contributions, composed by `order` like any other prompt. `ori code` uses
   * this to overlay the coding persona on the global workspace; empty otherwise.
   */
  readonly builtInPrompts?: readonly ImportedContribution<PromptContribution>[];
  readonly builtInSchedules?: readonly ImportedContribution<ScheduleEntry>[];
  readonly builtInSkills?: readonly ImportedContribution<SkillContribution>[];
  readonly builtInSkillWarnings?: readonly string[];
  readonly disabledSkillNames?: readonly string[];
  readonly reload?: {
    readonly affectedFeatureIds?: readonly string[] | undefined;
    readonly previousFeatures?: readonly ResolvedFeature[] | undefined;
    readonly previousImported?: ImportedFeatureContributions | undefined;
    readonly previousPackageInfos?: readonly FeaturePackageInfo[] | undefined;
  };
  readonly featuresRoot: string;
  /**
   * Workspace root that owns this boot (the parent of `featuresRoot`). Used to
   * locate the root-persona `ori.md` (RFC 0002 root-persona.md). Optional: when omitted, boot
   * derives it as `dirname(featuresRoot)`.
   */
  readonly workspaceRoot?: string;
}
