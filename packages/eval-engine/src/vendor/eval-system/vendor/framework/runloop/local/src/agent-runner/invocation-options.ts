import type { RuntimeHarnessInvokeOptions } from "../../../../engine/harness/src/options.ts";
import type { AgentRunnerCommand } from "./service.ts";

/** Assemble the harness `invokeOptions`, threading through only the defined optional fields. */
export const makeHarnessInvokeOptions = (input: {
  readonly assembledSystemPrompt: string | undefined;
  readonly command: AgentRunnerCommand;
  readonly contextWindow: number | undefined;
  readonly cwd: string;
  readonly disableBundledSkills: boolean;
  readonly extraSkillDirs: readonly string[] | undefined;
  readonly model: string | null | undefined;
  readonly parameters: AgentRunnerCommand["parameters"];
  readonly env: Record<string, string | undefined>;
}): RuntimeHarnessInvokeOptions => {
  const { assembledSystemPrompt, command, contextWindow, cwd, model } = input;
  return {
    cancelState: command.cancelState,
    cancelSignal: command.cancelSignal,
    contextWindow,
    cwd,
    disableBundledSkills: input.disableBundledSkills,
    env: input.env,
    extraSkillDirs: input.extraSkillDirs,
    interactionSurface: command.interactionSurface,
    model,
    parameters: input.parameters,
    outputSchema: command.outputSchema,
    prompt: command.prompt,
    sessionId: command.sessionId,
    systemPrompt: assembledSystemPrompt,
    temperature: command.temperature,
    type: "invokeOptions",
    userId: command.userId,
  } satisfies RuntimeHarnessInvokeOptions;
};
