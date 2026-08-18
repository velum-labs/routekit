import type { RuntimeHarnessCompactionOptions } from "../../../../engine/harness/src/options.ts";
import type { AgentRunnerCommand } from "./service.ts";

export const makeHarnessCompactionOptions = (input: {
  readonly assembledSystemPrompt: string | undefined;
  readonly command: AgentRunnerCommand;
  readonly contextWindow: number | undefined;
  readonly cwd: string;
  readonly disableBundledSkills: boolean;
  readonly env: Record<string, string | undefined>;
  readonly extraSkillDirs: readonly string[] | undefined;
  readonly model: string | null | undefined;
  readonly parameters: AgentRunnerCommand["parameters"];
}): RuntimeHarnessCompactionOptions => ({
  cancelState: input.command.cancelState,
  cancelSignal: input.command.cancelSignal,
  contextWindow: input.contextWindow,
  cwd: input.cwd,
  disableBundledSkills: input.disableBundledSkills,
  env: input.env,
  extraSkillDirs: input.extraSkillDirs,
  interactionSurface: input.command.interactionSurface,
  model: input.model,
  parameters: input.parameters,
  sessionId: input.command.sessionId,
  systemPrompt: input.assembledSystemPrompt,
  temperature: input.command.temperature,
  type: "invokeOptions",
  userId: input.command.userId,
});
