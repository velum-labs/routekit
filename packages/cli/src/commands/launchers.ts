import { resolve } from "node:path";

import { contextFor } from "@velum-labs/routekit-cli-core";
import { commandOnPath, isLoopbackHost, trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type { ToolSessionIntent } from "@velum-labs/routekit-tools";
import type { Command } from "commander";
import { routekitClient } from "../client.js";
import { launchTool, routekitToolRegistry } from "../launch.js";
import { isLaunchToolId, type LaunchToolId } from "../launch-support.js";
import {
  createSession,
  getSession,
  newestResumableSession,
  type RouteKitSession,
  type SessionTargetIdentity,
  type SessionTool,
  sessionRepositoryIdentity,
  updateSession
} from "../sessions.js";
import { type RouteKitTarget, resolveTarget, resolveTargetIdentity } from "../target.js";

import { registerClaudeIntegration, registerCodexIntegration } from "./install.js";

export async function resolveLauncherPreparation(
  input: { tool: LaunchToolId; model?: string; cwd: string; target?: RouteKitTarget },
  dependencies: {
    resolve?: typeof resolveTarget;
    client?: typeof routekitClient;
  } = {}
): Promise<{
  tool: LaunchToolId | "opencode";
  gatewayUrl: string;
  authToken?: string;
  model?: string;
  env: Record<string, string>;
}> {
  const target = input.target ?? (await (dependencies.resolve ?? resolveTarget)());
  if (target.kind === "remote") {
    return {
      tool: input.tool,
      gatewayUrl: target.remote.gatewayUrl,
      authToken: target.authToken,
      ...(input.model !== undefined ? { model: input.model } : {}),
      env: {}
    };
  }
  return await (await (dependencies.client ?? routekitClient)()).call("launcher.prepare", {
    tool: input.tool,
    ...(input.model !== undefined ? { model: input.model } : {}),
    cwd: input.cwd
  });
}

function targetIdentity(target: RouteKitTarget): SessionTargetIdentity {
  return target.kind === "local" ? { kind: "local" } : { kind: "remote", name: target.remote.name };
}

function sameRepository(
  left: RouteKitSession["repository"],
  right: RouteKitSession["repository"]
): boolean {
  return left.kind === right.kind && left.root === right.root;
}

function resumableSessionTool(tool: LaunchToolId): SessionTool {
  if (tool === "claude" || tool === "codex") return tool;
  throw new Error(`internal error: resumable integration has unsupported tool id ${tool}`);
}

function staleNativeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:session|conversation).*(?:not found|does not exist|missing|stale|unknown)|(?:not found|missing).*(?:session|conversation)/i.test(
    message
  );
}

async function managedLaunch(input: {
  tool: LaunchToolId;
  args: readonly string[];
  invocationCwd: string;
  resume?: string;
}): Promise<number> {
  const integration = routekitToolRegistry.get(input.tool);
  if (integration?.session.status !== "resumable") {
    throw new Error(
      `\`${input.tool}\` does not support RouteKit session resume; use \`routekit claude --resume <RouteKit ID>\``
    );
  }
  const sessionTool = resumableSessionTool(input.tool);
  const invocationIdentity = sessionRepositoryIdentity(input.invocationCwd);
  const existing =
    input.resume !== undefined
      ? getSession(input.resume)
      : newestResumableSession(sessionTool, input.invocationCwd);
  if (existing === undefined) {
    throw new Error(
      input.resume !== undefined
        ? `unknown or unavailable RouteKit session: ${input.resume}; run \`routekit sessions list\``
        : `no resumable ${input.tool} session exists in this repository; run \`routekit ${input.tool}\` first`
    );
  }
  if (existing.tool !== input.tool) {
    throw new Error(
      `RouteKit session ${existing.id} belongs to ${existing.tool}, not ${input.tool}`
    );
  }
  if (existing.status !== "resumable") {
    throw new Error(`RouteKit session ${existing.id} is ${existing.status} and cannot be resumed`);
  }
  if (!sameRepository(existing.repository, invocationIdentity.repository)) {
    throw new Error(
      `RouteKit session ${existing.id} belongs to a different repository (${existing.repository.root}); run the command from that worktree`
    );
  }
  const target = await resolveTargetIdentity(existing.target);
  const prepared = await resolveLauncherPreparation({
    tool: input.tool,
    model: existing.model,
    cwd: existing.cwd,
    target
  });
  try {
    const result = await launchTool({
      tool: input.tool,
      gatewayUrl: prepared.gatewayUrl,
      model: existing.model,
      reasoning: existing.reasoning,
      args: input.args,
      cwd: existing.cwd,
      ...(prepared.authToken !== undefined ? { authToken: prepared.authToken } : {}),
      session: {
        mode: "resume",
        cursor: existing.resume as Extract<ToolSessionIntent, { mode: "resume" }>["cursor"]
      }
    });
    await updateSession(existing.id, {
      status: "resumable",
      ...(result.resumeCursor !== undefined ? { resume: result.resumeCursor } : {})
    });
    return result.exitCode;
  } catch (error) {
    if (staleNativeSessionError(error)) {
      await updateSession(existing.id, { status: "stale" });
    }
    throw error;
  }
}

async function newManagedLaunch(input: {
  tool: SessionTool;
  model?: string;
  effort?: string;
  args: readonly string[];
  cwd: string;
}): Promise<number> {
  const target = await resolveTarget();
  const prepared = await resolveLauncherPreparation({
    tool: input.tool,
    ...(input.model !== undefined ? { model: input.model } : {}),
    cwd: input.cwd,
    target
  });
  let sessionPromise: Promise<RouteKitSession> | undefined;
  let session: RouteKitSession | undefined;
  try {
    const result = await launchTool({
      tool: input.tool,
      gatewayUrl: prepared.gatewayUrl,
      ...(prepared.model !== undefined
        ? { model: prepared.model }
        : input.model !== undefined
          ? { model: input.model }
          : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      args: input.args,
      cwd: input.cwd,
      ...(prepared.authToken !== undefined ? { authToken: prepared.authToken } : {}),
      session: { mode: "new" },
      publishResumeCursor: async (cursor, spec) => {
        sessionPromise ??= createSession({
          tool: input.tool,
          resume: cursor,
          cwd: input.cwd,
          model: spec.defaultModel,
          ...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
          target: targetIdentity(target),
          status: "launching"
        });
        session = await sessionPromise;
      }
    });
    if (session !== undefined) {
      await updateSession(session.id, {
        status: "resumable",
        ...(result.resumeCursor !== undefined ? { resume: result.resumeCursor } : {})
      });
    }
    return result.exitCode;
  } catch (error) {
    session ??= await sessionPromise;
    if (session !== undefined) {
      await updateSession(session.id, { status: "resumable" });
    }
    throw error;
  }
}

export function registerLaunchers(program: Command): void {
  for (const integration of routekitToolRegistry
    .list()
    .filter((entry) => isLaunchToolId(entry.id))) {
    const command = program
      .command(integration.id)
      .description(
        integration.id === "codex"
          ? "launch Codex through RouteKit (Responses-only; best-effort model filtering)"
          : `launch ${integration.displayName} through RouteKit`
      )
      .argument("[model]", "live namespaced provider/model id")
      .argument("[toolArgs...]", `arguments passed to ${integration.displayName}`)
      .option("--gateway-url <url>", "connect to an existing RouteKit gateway")
      .option("--effort <id>", "opaque reasoning effort for the selected model")
      .option("--auth-token <token>", "gateway authentication token")
      .option(
        "--auth-token-env <name>",
        "read gateway authentication token from an environment variable"
      )
      .option("--cwd <dir>", "tool working directory")
      .option("--resume <id>", "resume a RouteKit-managed session")
      .option("--continue", "resume the newest RouteKit session in this repository");
    if (integration.id === "codex") registerCodexIntegration(command);
    if (integration.id === "claude") registerClaudeIntegration(command);
    command.action(
      async (
        model: string | undefined,
        toolArgs: string[],
        options: {
          gatewayUrl?: string;
          authToken?: string;
          authTokenEnv?: string;
          cwd?: string;
          effort?: string;
          resume?: string;
          continue?: boolean;
        },
        actionCommand: Command
      ) => {
        if (contextFor(actionCommand).json) {
          throw new Error(`\`${integration.id}\` is interactive and does not support --json`);
        }
        if (options.resume !== undefined && options.continue === true) {
          throw new Error("--resume and --continue are mutually exclusive");
        }
        const sessionRequested = options.resume !== undefined || options.continue === true;
        if (sessionRequested && integration.session.status !== "resumable") {
          throw new Error(
            `\`${integration.id}\` does not support RouteKit session resume; use \`routekit claude --resume <RouteKit ID>\``
          );
        }
        if (sessionRequested && (model !== undefined || options.effort !== undefined)) {
          throw new Error(
            "model and --effort cannot be supplied with --resume or --continue; the stored session values are restored"
          );
        }
        if (options.gatewayUrl !== undefined && sessionRequested) {
          throw new Error(
            "--gateway-url cannot be combined with --resume or --continue because external gateways are not enrolled"
          );
        }
        if (integration.binary !== undefined && !commandOnPath(integration.binary)) {
          throw new Error(
            `routekit preflight failed: "${integration.binary}" was not found on PATH — ` +
              (integration.installHint ?? `install ${integration.binary}`)
          );
        }
        const cwd = options.cwd !== undefined ? resolve(options.cwd) : process.cwd();
        if (sessionRequested) {
          process.exitCode = await managedLaunch({
            tool: integration.id as LaunchToolId,
            args: toolArgs,
            invocationCwd: cwd,
            ...(options.resume !== undefined ? { resume: options.resume } : {})
          });
          return;
        }
        const externalToken =
          options.authTokenEnv !== undefined
            ? process.env[options.authTokenEnv]
            : options.authToken;
        if (options.authTokenEnv !== undefined && externalToken === undefined) {
          throw new Error(`credential environment variable is not set: ${options.authTokenEnv}`);
        }
        if (options.gatewayUrl !== undefined && externalToken !== undefined) {
          const external = new URL(options.gatewayUrl);
          if (external.protocol !== "https:" && !isLoopbackHost(external.hostname)) {
            throw new Error("authenticated external gateways require HTTPS");
          }
        }
        const tool = integration.id as LaunchToolId;
        if (options.gatewayUrl === undefined && integration.session.status === "resumable") {
          process.exitCode = await newManagedLaunch({
            tool: resumableSessionTool(tool),
            ...(model !== undefined ? { model } : {}),
            ...(options.effort !== undefined ? { effort: options.effort } : {}),
            args: toolArgs,
            cwd
          });
          return;
        }
        const prepared =
          options.gatewayUrl === undefined
            ? await resolveLauncherPreparation({
                tool,
                ...(model !== undefined ? { model } : {}),
                cwd
              })
            : undefined;
        const result = await launchTool({
          tool: integration.id,
          gatewayUrl:
            options.gatewayUrl !== undefined
              ? trimTrailingSlashes(options.gatewayUrl)
              : prepared!.gatewayUrl,
          ...(prepared?.model !== undefined
            ? { model: prepared.model }
            : model !== undefined
              ? { model }
              : {}),
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          args: toolArgs,
          cwd,
          ...((options.gatewayUrl !== undefined ? externalToken : prepared?.authToken) !== undefined
            ? { authToken: options.gatewayUrl !== undefined ? externalToken : prepared?.authToken }
            : {})
        });
        process.exitCode = result.exitCode;
      }
    );
  }
}
