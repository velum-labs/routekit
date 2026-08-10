import { hasFlag, spawnTool } from "@velum-labs/routekit-runtime";
import type { AgentProfile, ToolLaunchContext } from "@velum-labs/routekit-tools";

export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: authToken ?? "routekit",
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
    ...(process.env.CLAUDE_CONFIG_DIR !== undefined
      ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
      : {})
  };
}

export function claudeModelId(modelId: string): string {
  return `anthropic.routekit.${modelId}`;
}

/** Serialize host-authored profiles once into Claude's session agent format. */
export function claudeAgentsJson(profiles: readonly AgentProfile[]): string {
  return JSON.stringify(
    Object.fromEntries(
      profiles.map((profile) => [
        profile.id,
        {
          description: profile.description,
          prompt: profile.instructions,
          model: claudeModelId(profile.model)
        }
      ])
    )
  );
}

export function claudeLaunchArgs(ctx: ToolLaunchContext): string[] {
  const args = [...ctx.spec.args];
  if (!hasFlag(args, "--model")) {
    args.unshift("--model", claudeModelId(ctx.spec.defaultModel));
    if (ctx.spec.reasoning?.mode === "effort" && !hasFlag(args, "--effort")) {
      args.unshift("--effort", ctx.spec.reasoning.effort);
    }
  }
  const profiles = ctx.spec.agentProfiles ?? [];
  if (profiles.length > 0 && !hasFlag(args, "--agents")) {
    args.push("--agents", claudeAgentsJson(profiles));
  }
  return args;
}

export async function launchClaude(ctx: ToolLaunchContext): Promise<number> {
  ctx.prepareForPassthrough();
  return await spawnTool(
    "claude",
    claudeLaunchArgs(ctx),
    claudeEnv(ctx.spec.gatewayUrl, ctx.spec.auth?.token),
    ctx.spec.cwd
  );
}
