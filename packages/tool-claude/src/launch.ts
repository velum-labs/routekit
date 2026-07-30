import { randomUUID } from "node:crypto";

import {
  EFFORT_QUALIFIED_MODEL_CODEC,
  effortQualifiedClientModel
} from "@velum-labs/routekit-contracts";
import type { ResumeCursor } from "@velum-labs/routekit-harness-core";
import { spawnTool } from "@velum-labs/routekit-runtime";
import type { AgentProfile, ToolLaunchContext, ToolLaunchResult } from "@velum-labs/routekit-tools";

const CLAUDE_RESUME_CURSOR_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_SESSION_FLAGS = ["--session-id", "--resume", "--continue"] as const;

export function claudeResumeCursor(sessionId: string): ResumeCursor {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`invalid Claude session id: ${sessionId}`);
  }
  return {
    version: CLAUDE_RESUME_CURSOR_VERSION,
    kind: "claude_code",
    data: { sessionId }
  };
}

export function claudeResumeSessionId(cursor: ResumeCursor): string {
  if (cursor.version !== CLAUDE_RESUME_CURSOR_VERSION || cursor.kind !== "claude_code") {
    throw new Error("Claude resume requires a compatible claude_code cursor");
  }
  const data = cursor.data as { sessionId?: unknown };
  if (typeof data.sessionId !== "string" || !UUID_PATTERN.test(data.sessionId)) {
    throw new Error("Claude resume cursor contains an invalid session id");
  }
  return data.sessionId;
}

function hasManagedSessionArg(args: readonly string[]): string | undefined {
  return args.find((arg) =>
    MANAGED_SESSION_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  );
}

export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: authToken ?? "routekit",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...(process.env.CLAUDE_CONFIG_DIR !== undefined
      ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
      : {})
  };
}

export function claudeModelId(modelId: string): string {
  const pickerId = modelId.startsWith("claude-code/")
    ? modelId.slice("claude-code/".length)
    : modelId;
  return pickerId.startsWith("claude") || pickerId.startsWith("anthropic")
    ? pickerId
    : `claude-${pickerId}`;
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

function hasAgentsArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--agents" || arg.startsWith("--agents="));
}

function hasModelArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--model" || arg.startsWith("--model="));
}

export function claudeLaunchArgs(ctx: ToolLaunchContext): string[] {
  const args = [...ctx.spec.args];
  const session = ctx.spec.session;
  if (session !== undefined) {
    const conflicting = hasManagedSessionArg(args);
    if (conflicting !== undefined) {
      throw new Error(`cannot forward ${conflicting} when RouteKit is managing the Claude session`);
    }
    const sessionId = session.mode === "new" ? randomUUID() : claudeResumeSessionId(session.cursor);
    args.unshift(session.mode === "new" ? "--session-id" : "--resume", sessionId);
  }
  if (!hasModelArg(args)) {
    args.unshift(
      "--model",
      effortQualifiedClientModel(
        claudeModelId(ctx.spec.defaultModel),
        ctx.spec.reasoning,
        EFFORT_QUALIFIED_MODEL_CODEC
      )
    );
  }
  const profiles = ctx.spec.agentProfiles ?? [];
  if (profiles.length > 0 && !hasAgentsArg(args)) {
    args.push("--agents", claudeAgentsJson(profiles));
  }
  return args;
}

export async function prepareClaudeLaunch(ctx: ToolLaunchContext): Promise<{
  args: string[];
  resumeCursor?: ResumeCursor;
}> {
  const args = claudeLaunchArgs(ctx);
  if (ctx.spec.session === undefined) return { args };
  const flag = ctx.spec.session.mode === "new" ? "--session-id" : "--resume";
  const sessionId = args[args.indexOf(flag) + 1];
  if (sessionId === undefined) throw new Error("Claude session argument is missing its id");
  const resumeCursor = claudeResumeCursor(sessionId);
  await ctx.publishResumeCursor?.(resumeCursor);
  return { args, resumeCursor };
}

export async function launchClaude(ctx: ToolLaunchContext): Promise<ToolLaunchResult> {
  const { args, resumeCursor } = await prepareClaudeLaunch(ctx);
  ctx.prepareForPassthrough();
  const exitCode = await spawnTool(
    "claude",
    args,
    claudeEnv(ctx.spec.gatewayUrl, ctx.spec.auth?.token),
    ctx.spec.cwd
  );
  return { exitCode, ...(resumeCursor !== undefined ? { resumeCursor } : {}) };
}
