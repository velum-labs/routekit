import { hostname as osHostname } from "node:os";

import { contextFor } from "@velum-labs/routekit-cli-core";
import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import type { ClaudeInstallOwner, CodexInstallOwner } from "@velum-labs/routekit-tool-registry";
import {
  claudeIntegrationConfigPath,
  codexIntegrationConfigPath,
  installClaudeIntegration,
  installCodexIntegration,
  uninstallClaudeIntegration,
  uninstallCodexIntegration
} from "@velum-labs/routekit-tool-registry";
import type { Command } from "commander";

import { fetchLiveCatalog } from "../catalog.js";
import { routekitClient } from "../client.js";
import {
  deleteNativeIntegration,
  getNativeIntegration,
  markNativeIntegrationTokenRevoked,
  type NativeIntegration,
  type NativeIntegrationTarget,
  type NativeIntegrationTool,
  putNativeIntegration
} from "../native-integrations.js";
import { findRemote } from "../remotes.js";
import { remoteControlClient } from "../ssh-control.js";
import { type RouteKitTarget, resolveTarget } from "../target.js";

const CODEX_OWNER: CodexInstallOwner = {
  id: "routekit",
  displayName: "RouteKit",
  providerId: "routekit",
  installCommand: "routekit codex install",
  uninstallCommand: "routekit codex uninstall",
  startCommand: "routekit start"
};

const CLAUDE_OWNER: ClaudeInstallOwner = {
  id: "routekit",
  displayName: "RouteKit",
  installCommand: "routekit claude install",
  uninstallCommand: "routekit claude uninstall",
  startCommand: "routekit start"
};

function catalogReasoning(value: unknown): ModelReasoningCapabilities | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const reasoning = value as Record<string, unknown>;
  if (
    (reasoning.status !== "supported" &&
      reasoning.status !== "unsupported" &&
      reasoning.status !== "unknown") ||
    (reasoning.provenance !== "provider" &&
      reasoning.provenance !== "config" &&
      reasoning.provenance !== "builtin" &&
      reasoning.provenance !== "unknown")
  ) {
    return undefined;
  }
  return reasoning as ModelReasoningCapabilities;
}

function targetIdentity(target: RouteKitTarget): NativeIntegrationTarget {
  return target.kind === "local" ? { kind: "local" } : { kind: "remote", name: target.remote.name };
}

function sameTarget(left: NativeIntegrationTarget, right: NativeIntegrationTarget): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "local" || right.kind === "local" ? true : left.name === right.name;
}

function tokenEnvironment(tool: NativeIntegrationTool): string {
  return tool === "codex" ? "ROUTEKIT_GATEWAY_TOKEN" : "ANTHROPIC_AUTH_TOKEN";
}

function tokenLabel(tool: NativeIntegrationTool): string {
  const host = osHostname()
    .replace(/[^a-zA-Z0-9._@-]/g, "-")
    .slice(0, 48);
  return `native-${tool}@${host}`;
}

async function controlFor(target: NativeIntegrationTarget) {
  if (target.kind === "local") return await routekitClient();
  if (target.kind === "remote") {
    const remote = findRemote(target.name);
    if (remote === undefined) {
      throw new Error(
        `the RouteKit remote recorded for this native client integration no longer exists: ${target.name}; re-add it before rotating or uninstalling`
      );
    }
    return remoteControlClient(remote);
  }
  throw new Error("unsupported native integration target");
}

async function issueToken(tool: NativeIntegrationTool, target: NativeIntegrationTarget) {
  return await (await controlFor(target)).call("tokens.issue", {
    label: tokenLabel(tool),
    plane: "data",
    createdBy: `native-client-install:${tool}`
  });
}

async function revokeToken(entry: NativeIntegration): Promise<void> {
  if (entry.tokenRevoked === true) return;
  await (await controlFor(entry.target)).call("tokens.revoke", { id: entry.tokenId });
}

async function prepareCredential(input: {
  tool: NativeIntegrationTool;
  configPath: string;
  target: NativeIntegrationTarget;
  rotate: boolean;
}): Promise<{ existing?: NativeIntegration; token?: string; tokenId?: string }> {
  const existing = getNativeIntegration(input.tool, input.configPath);
  if (existing !== undefined && !sameTarget(existing.target, input.target) && !input.rotate) {
    throw new Error(
      `this ${input.tool} integration targets a different RouteKit gateway; rerun with --rotate-token to replace its credential`
    );
  }
  if (existing?.tokenRevoked === true && !input.rotate) {
    throw new Error(
      `the dedicated ${input.tool} gateway token is already revoked; rerun with --rotate-token to issue a replacement`
    );
  }
  if (existing !== undefined && existing.tokenRevoked !== true && !input.rotate) {
    return { existing };
  }
  const issued = await issueToken(input.tool, input.target);
  if (existing !== undefined && existing.tokenRevoked !== true) {
    try {
      await revokeToken(existing);
      await markNativeIntegrationTokenRevoked(existing.tool, existing.configPath);
    } catch (error) {
      await (await controlFor(input.target))
        .call("tokens.revoke", { id: issued.id })
        .catch(() => undefined);
      throw error;
    }
  }
  return { existing, token: issued.token, tokenId: issued.id };
}

async function rememberCredential(input: {
  tool: NativeIntegrationTool;
  configPath: string;
  target: NativeIntegrationTarget;
  credential: { existing?: NativeIntegration; token?: string; tokenId?: string };
}): Promise<void> {
  if (input.credential.tokenId === undefined) return;
  await putNativeIntegration({
    tool: input.tool,
    configPath: input.configPath,
    target: input.target,
    tokenId: input.credential.tokenId
  });
}

function emitInstall(
  command: Command,
  input: {
    action: "installed" | "updated";
    configPath: string;
    tool: NativeIntegrationTool;
    token?: string;
  }
): void {
  const ctx = contextFor(command);
  if (ctx.json) {
    ctx.emit({
      action: input.action,
      configPath: input.configPath,
      ...(input.token !== undefined
        ? { token: input.token, authTokenEnv: tokenEnvironment(input.tool) }
        : {})
    });
    return;
  }
  ctx.presenter.success(`${input.action} RouteKit in ${input.configPath}`);
  if (input.token !== undefined) {
    process.stdout.write(`export ${tokenEnvironment(input.tool)}=${JSON.stringify(input.token)}\n`);
    ctx.presenter.note(
      "this gateway token is shown once; save it in your shell secret manager before starting the native client"
    );
  } else {
    ctx.presenter.note(
      `the existing ${tokenEnvironment(input.tool)} value remains in use; pass --rotate-token to issue a replacement`
    );
  }
}

export function registerCodexIntegration(codex: Command): void {
  codex
    .command("install")
    .description("install one RouteKit Codex profile with a gateway-backed model picker")
    .option("--codex-home <dir>", "Codex home directory")
    .option("--rotate-token", "replace the dedicated gateway token")
    .action(async (options: { codexHome?: string; rotateToken?: boolean }, command: Command) => {
      const target = await resolveTarget();
      const targetId = targetIdentity(target);
      const configPath = codexIntegrationConfigPath(options.codexHome);
      const prepared =
        target.kind === "remote"
          ? {
              gatewayUrl: target.remote.gatewayUrl,
              catalog: await fetchLiveCatalog(target.remote.gatewayUrl, {
                authToken: target.authToken
              })
            }
          : await (async () => {
              const client = await routekitClient();
              const [daemon, catalog] = await Promise.all([
                client.call("daemon.status", {}),
                client.call("models.list", {})
              ]);
              return { gatewayUrl: daemon.dataUrl, catalog };
            })();
      const credential = await prepareCredential({
        tool: "codex",
        configPath,
        target: targetId,
        rotate: options.rotateToken === true
      });
      try {
        const result = installCodexIntegration({
          gatewayUrl: prepared.gatewayUrl,
          profiles: prepared.catalog.models.map((modelId) => {
            const reasoning = catalogReasoning(modelId.reasoning);
            return {
              modelId: modelId.id,
              ...(reasoning !== undefined ? { reasoning } : {})
            };
          }),
          defaultModel: prepared.catalog.defaultModel,
          profileId: "routekit",
          owner: CODEX_OWNER,
          ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
        });
        await rememberCredential({
          tool: "codex",
          configPath: result.configPath,
          target: targetId,
          credential
        });
        emitInstall(command, {
          action: result.action,
          configPath: result.configPath,
          tool: "codex",
          token: credential.token
        });
      } catch (error) {
        if (credential.tokenId !== undefined) {
          await (await controlFor(targetId))
            .call("tokens.revoke", { id: credential.tokenId })
            .catch(() => undefined);
        }
        throw error;
      }
    });

  codex
    .command("uninstall")
    .description("remove RouteKit-owned Codex configuration and its dedicated token")
    .option("--codex-home <dir>", "Codex home directory")
    .action(async (options: { codexHome?: string }, command: Command) => {
      const configPath = codexIntegrationConfigPath(options.codexHome);
      const existing = getNativeIntegration("codex", configPath);
      if (existing !== undefined && existing.tokenRevoked !== true) {
        await revokeToken(existing);
        await markNativeIntegrationTokenRevoked("codex", configPath);
      }
      const result = uninstallCodexIntegration({
        ownerId: CODEX_OWNER.id,
        ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
      });
      await deleteNativeIntegration("codex", configPath);
      const ctx = contextFor(command);
      if (ctx.json) ctx.emit(result);
      else if (result.removed) ctx.presenter.success(`removed RouteKit from ${result.configPath}`);
      else ctx.presenter.note(`no RouteKit block found in ${result.configPath}`);
    });
}

export function registerClaudeIntegration(claude: Command): void {
  claude
    .command("install")
    .description("install RouteKit-owned Claude Code gateway settings")
    .option("--claude-config-dir <dir>", "Claude Code configuration directory")
    .option("--rotate-token", "replace the dedicated gateway token")
    .action(
      async (options: { claudeConfigDir?: string; rotateToken?: boolean }, command: Command) => {
        const target = await resolveTarget();
        const targetId = targetIdentity(target);
        const configPath = claudeIntegrationConfigPath(options.claudeConfigDir);
        const gatewayUrl =
          target.kind === "remote"
            ? target.remote.gatewayUrl
            : (await (await routekitClient()).call("daemon.status", {})).dataUrl;
        const credential = await prepareCredential({
          tool: "claude",
          configPath,
          target: targetId,
          rotate: options.rotateToken === true
        });
        try {
          const result = await installClaudeIntegration({
            gatewayUrl,
            owner: CLAUDE_OWNER,
            ...(options.claudeConfigDir !== undefined
              ? { claudeConfigDir: options.claudeConfigDir }
              : {})
          });
          await rememberCredential({
            tool: "claude",
            configPath: result.configPath,
            target: targetId,
            credential
          });
          emitInstall(command, {
            action: result.action,
            configPath: result.configPath,
            tool: "claude",
            token: credential.token
          });
        } catch (error) {
          if (credential.tokenId !== undefined) {
            await (await controlFor(targetId))
              .call("tokens.revoke", { id: credential.tokenId })
              .catch(() => undefined);
          }
          throw error;
        }
      }
    );

  claude
    .command("uninstall")
    .description("remove RouteKit-owned Claude Code settings and its dedicated token")
    .option("--claude-config-dir <dir>", "Claude Code configuration directory")
    .action(async (options: { claudeConfigDir?: string }, command: Command) => {
      const configPath = claudeIntegrationConfigPath(options.claudeConfigDir);
      const existing = getNativeIntegration("claude", configPath);
      if (existing !== undefined && existing.tokenRevoked !== true) {
        await revokeToken(existing);
        await markNativeIntegrationTokenRevoked("claude", configPath);
      }
      const result = await uninstallClaudeIntegration({
        ownerId: CLAUDE_OWNER.id,
        ...(options.claudeConfigDir !== undefined
          ? { claudeConfigDir: options.claudeConfigDir }
          : {})
      });
      await deleteNativeIntegration("claude", configPath);
      const ctx = contextFor(command);
      if (ctx.json) ctx.emit(result);
      else if (result.removed) ctx.presenter.success(`removed RouteKit from ${result.configPath}`);
      else ctx.presenter.note(`no RouteKit settings found in ${result.configPath}`);
    });
}
