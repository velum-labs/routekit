import type { AgentHarnessExport } from "./agent-harness.ts";
import type { ApiContribution } from "./api.ts";
import type { ChatContribution } from "./chat.ts";
import type { CommandContribution } from "./command.ts";
import type { HooksContribution } from "./hooks.ts";
import type { PromptExport } from "./prompt-generation.ts";
import type { ScheduleDefinition } from "./schedule.ts";
import type { ValueOf } from "../../../utils/core/src/types.ts";

// `model` is intentionally NOT a capability: the default orchestrator model is a
// static slug the agent harness loads (from `ori.md`/`SKILL.md` frontmatter, the
// built-in default, or the `--model` flag), not a feature-provided contribution.
// See RFC 0002 Root `ori.md` Persona for the resolver and precedence.
export const Capability = {
  Harness: "harness",
  Chat: "chat",
  Schedule: "schedule",
  Api: "api",
  Hooks: "hooks",
  Prompt: "prompt",
  Skill: "skill",
  Command: "command",
} as const;
export type Capability = ValueOf<typeof Capability>;

export interface FeatureModule {
  readonly harness?: AgentHarnessExport | undefined;
  readonly chat?: ChatContribution | undefined;
  readonly api?: ApiContribution | undefined;
  readonly hooks?: HooksContribution | undefined;
  /**
   * The feature's schedule (RFC 0002 schedule.md): a cron job that fires a headless agent
   * run. A feature owns at most one; it can also live in a standalone
   * `schedule.{ts,md}` file instead of this export.
   */
  readonly schedule?: ScheduleDefinition | undefined;
  /**
   * One or more dynamic prompt providers (RFC 0002 prompt.md) folded into the
   * assembled system prompt. Can also live in a standalone `prompt.ts` file as
   * a named `prompt` export; static fragments stay in `prompt.md`.
   */
  readonly prompt?: PromptExport | undefined;
  /**
   * A single deterministic command (RFC 0002 command.md): a `/name` action run as
   * plain code. Can also live in a standalone `command.ts` file. Use `commands`
   * for several in one feature.
   */
  readonly command?: CommandContribution | undefined;
  /** Several deterministic commands from one feature; each carries its own `name` (RFC 0002 command.md). */
  readonly commands?: readonly CommandContribution[] | undefined;
}

export type FeatureModuleExportName = keyof FeatureModule;
