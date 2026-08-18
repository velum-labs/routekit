import { Schema } from "effect";

import type {
  Capability as AuthorCapability,
  FeatureModule,
  FeatureModuleExportName as AuthorFeatureModuleExportName,
} from "../../../author/src/feature-manifest.ts";
import type { AssertAssignable } from "../type-boundary.ts";
/**
 * RFC 0002 feature discovery constants. Authors type `features/<id>/feature.ts`
 * with the plain TypeScript `FeatureModule` shape from `@ori-contracts/author`;
 * there is no `feature.json` manifest and no JSON Schema authoring contract.
 */
import type { ValueOf } from "../../../../utils/core/src/types.ts";

import { Capability as AuthorCapabilityValue } from "../../../author/src/feature-manifest.ts";

const ContributionMode = {
  Aggregate: "aggregate",
  Extension: "extension",
  SingleProvider: "single-provider",
} as const;
type ContributionMode = ValueOf<typeof ContributionMode>;

const Capability = AuthorCapabilityValue;

const CAPABILITY_KINDS = [
  Capability.Harness,
  Capability.Chat,
  Capability.Schedule,
  Capability.Api,
  Capability.Hooks,
  Capability.Prompt,
  Capability.Skill,
  Capability.Command,
] as const satisfies readonly AuthorCapability[];

type Capability = (typeof CAPABILITY_KINDS)[number];
type _CapabilitiesCoverAuthor = AssertAssignable<AuthorCapability, Capability>;
type _CapabilitiesAreAuthorKinds = AssertAssignable<
  Capability,
  AuthorCapability
>;

/** The closed set of additive capability kinds (RFC 0002). */
const CapabilitySchema = Schema.Literals(CAPABILITY_KINDS);

const FEATURE_MODULE_FILE = "feature.ts";

const FEATURE_MODULE_EXPORT_NAMES = [
  "harness",
  "chat",
  "schedule",
  "api",
  "hooks",
  "prompt",
  "command",
  "commands",
] as const satisfies readonly AuthorFeatureModuleExportName[];

type FeatureModuleExportName = (typeof FEATURE_MODULE_EXPORT_NAMES)[number];
type _FeatureModuleExportNamesCoverAuthor = AssertAssignable<
  AuthorFeatureModuleExportName,
  FeatureModuleExportName
>;
type _FeatureModuleExportNamesAreAuthorExports = AssertAssignable<
  FeatureModuleExportName,
  keyof FeatureModule
>;

export interface FeatureModuleExportDescriptor {
  readonly capability?: Capability;
  readonly entryKey: Capability | FeatureModuleExportName;
  readonly exportName: FeatureModuleExportName;
  readonly file: typeof FEATURE_MODULE_FILE;
  readonly mode: ContributionMode;
  readonly registryKey?: string;
}

export const FEATURE_MODULE_EXPORTS = [
  {
    capability: Capability.Harness,
    entryKey: "harness",
    exportName: "harness",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.SingleProvider,
    registryKey: "harnesses",
  },
  {
    capability: Capability.Chat,
    entryKey: "chat",
    exportName: "chat",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Aggregate,
    registryKey: "chats",
  },
  {
    capability: Capability.Schedule,
    entryKey: "schedule",
    exportName: "schedule",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Aggregate,
    registryKey: "schedules",
  },
  {
    capability: Capability.Api,
    entryKey: "api",
    exportName: "api",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Extension,
    registryKey: "apis",
  },
  {
    capability: Capability.Hooks,
    entryKey: "hooks",
    exportName: "hooks",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Extension,
    registryKey: "hooks",
  },
  {
    capability: Capability.Prompt,
    entryKey: "prompt",
    exportName: "prompt",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Aggregate,
    registryKey: "prompts",
  },
  {
    capability: Capability.Command,
    entryKey: "command",
    exportName: "command",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Extension,
    registryKey: "commands",
  },
  {
    capability: Capability.Command,
    entryKey: "commands",
    exportName: "commands",
    file: FEATURE_MODULE_FILE,
    mode: ContributionMode.Extension,
    registryKey: "commands",
  },
] as const satisfies readonly FeatureModuleExportDescriptor[];

export interface DataContributionFile {
  readonly entryKey: Extract<Capability, "prompt" | "skill">;
  readonly file: string;
  readonly kind: Extract<Capability, "prompt" | "skill">;
  readonly mode: ContributionMode;
  readonly registryKey?: string;
}

export const DATA_CONTRIBUTION_FILES = [
  {
    entryKey: Capability.Prompt,
    file: "prompt.md",
    kind: Capability.Prompt,
    mode: ContributionMode.Aggregate,
    registryKey: "prompts",
  },
  {
    entryKey: Capability.Skill,
    file: "SKILL.md",
    kind: Capability.Skill,
    mode: ContributionMode.Extension,
    registryKey: "skills",
  },
] as const satisfies readonly DataContributionFile[];

/**
 * A schedule (RFC 0002 schedule.md) can be authored three ways, mirroring the skill
 * `SKILL.md` + `skills/<name>/SKILL.md` pattern: the `feature.ts` `schedule`
 * export or a standalone top-level `schedule.{ts,md}` file (the feature-named
 * schedule), and any number of nested `schedules/<name>/schedule.{ts,md}` files
 * (each named for its folder). `.ts` carries a `defineSchedule` default export,
 * `.md` carries cron frontmatter with the body as the prompt.
 */
export const SCHEDULE_FILE_CANDIDATES = ["schedule.ts", "schedule.md"] as const;

/** Directory holding nested schedule contributions: `schedules/<name>/schedule.{ts,md}` (RFC 0002 schedule.md). */
export const SCHEDULES_DIR = "schedules";

/**
 * Prefix carried by a nested schedule's `entryKey` (`schedule/<name>`). A
 * cross-package string contract: the feature loader (engine) mints the key and
 * the runloop's schedule contribution loader slices the `<name>` back off, so
 * both sides import this constant rather than agreeing by coincidence.
 */
export const NESTED_SCHEDULE_ENTRY_PREFIX = "schedule/";

/**
 * The grammar of a workspace feature id (RFC 0002 §Name uniqueness): the id IS
 * the directory name under `features/`, so this is a directory-name policy,
 * not just a scaffold nicety. Shared by the scaffold command (rejects bad
 * names up front) and the feature loader (diagnoses a bad directory that
 * arrived by other means, e.g. `git mv` or hand creation) so the two cannot
 * drift. Built-in feature ids (`@ori-builtins/*`) are minted in code, never
 * loaded from disk, and deliberately live outside this grammar.
 */
export const WORKSPACE_FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * A prompt (RFC 0002 prompt.md) can be authored as the `feature.ts` `prompt`
 * export, as a static `prompt.md` data file, or as a standalone top-level
 * `prompt.ts` module carrying a named `prompt` export (with optional `name`
 * and `order` named exports). Like a command, the standalone form is always
 * code, so there is no nested directory variant.
 */
export const PROMPT_FILE_CANDIDATES = ["prompt.ts"] as const;

/**
 * A command (RFC 0002 command.md) can be authored as the `feature.ts`
 * `command`/`commands` export or as standalone code files: a top-level
 * `command.ts` (the feature-named command) and any number of nested
 * `commands/<name>/command.ts` files (each named for its folder). Unlike a
 * schedule, a command is always code, so there is no `.md` form.
 */
export const COMMAND_FILE_CANDIDATES = ["command.ts"] as const;

/** Directory holding nested command contributions: `commands/<name>/command.ts` (RFC 0002 command.md). */
export const COMMANDS_DIR = "commands";

/**
 * Prefix carried by a nested command's `entryKey` (`command/<name>`). A
 * cross-package string contract: the feature loader (engine) mints the key and
 * the runloop's command contribution loader slices the `<name>` back off, so both
 * sides import this constant rather than agreeing by coincidence.
 */
export const NESTED_COMMAND_ENTRY_PREFIX = "command/";

export type FeatureContributionDescriptor =
  | FeatureModuleExportDescriptor
  | DataContributionFile;

/** All convention-discovered contribution descriptors, in RFC resolution order. */
export const FEATURE_CONTRIBUTION_DESCRIPTORS = [
  ...FEATURE_MODULE_EXPORTS,
  ...DATA_CONTRIBUTION_FILES,
] as const satisfies readonly FeatureContributionDescriptor[];

export {
  ContributionMode,
  Capability,
  CAPABILITY_KINDS,
  CapabilitySchema,
  FEATURE_MODULE_FILE,
  FEATURE_MODULE_EXPORT_NAMES,
};
export type { FeatureModuleExportName };
