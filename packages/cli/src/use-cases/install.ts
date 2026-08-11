import { hostname as osHostname } from "node:os";

import type { CommandContext } from "@velum-labs/routekit-cli-core";
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

import { fetchLiveCatalog } from "../catalog.js";
import { routekitClient } from "../client.js";
import {
  nativeCredentialHelper,
  nativeCredentialShellCommand
} from "../native-credential-helper.js";
import {
  deleteNativeCredential,
  readNativeCredential,
  writeNativeCredential
} from "../native-credentials.js";
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
  const remote = findRemote(target.name);
  if (remote === undefined) {
    throw new Error(
      `the RouteKit remote recorded for this native client integration no longer exists: ${target.name}; re-add it before rotating or uninstalling`
    );
  }
  return remoteControlClient(remote);
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
    const stored = await readNativeCredential(input.tool, input.configPath);
    if (stored !== undefined) return { existing };
    throw new Error(
      `the managed credential for this ${input.tool} integration is missing; ` +
        "rerun with --rotate-token to issue a replacement"
    );
  }
  const issued = await (await controlFor(input.target)).call("tokens.issue", {
    label: tokenLabel(input.tool),
    plane: "data",
    createdBy: `native-client-install:${input.tool}`
  });
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
  if (input.credential.token !== undefined) {
    await writeNativeCredential(input.tool, input.configPath, input.credential.token);
  }
  if (input.credential.tokenId === undefined && input.credential.existing === undefined) return;
  await putNativeIntegration({
    tool: input.tool,
    configPath: input.configPath,
    target: input.target,
    tokenId: input.credential.tokenId ?? input.credential.existing!.tokenId,
    ...(input.credential.tokenId === undefined && input.credential.existing?.tokenRevoked === true
      ? { tokenRevoked: true }
      : {})
  });
}

function assertNoTokenTarget(
  tool: NativeIntegrationTool,
  configPath: string,
  target: NativeIntegrationTarget
): void {
  const existing = getNativeIntegration(tool, configPath);
  if (existing !== undefined && !sameTarget(existing.target, target)) {
    throw new Error(
      `this ${tool} integration targets a different RouteKit gateway; --no-token will not replace its credential`
    );
  }
}

export type InstallNativeIntegrationInput =
  | {
      tool: "codex";
      options: { codexHome?: string; rotateToken?: boolean; token?: boolean };
      context: CommandContext;
    }
  | {
      tool: "claude";
      options: { claudeConfigDir?: string; rotateToken?: boolean; token?: boolean };
      context: CommandContext;
    };

export class InstallNativeIntegration {
  async execute(input: InstallNativeIntegrationInput): Promise<void> {
    const noToken = input.options.token === false;
    if (noToken && input.options.rotateToken === true) {
      throw new Error("--no-token cannot be combined with --rotate-token");
    }
    const target = await resolveTarget();
    const targetId = targetIdentity(target);
    const configPath =
      input.tool === "codex"
        ? codexIntegrationConfigPath(input.options.codexHome)
        : claudeIntegrationConfigPath(input.options.claudeConfigDir);
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
    const credential = noToken
      ? (assertNoTokenTarget(input.tool, configPath, targetId), {})
      : await prepareCredential({
          tool: input.tool,
          configPath,
          target: targetId,
          rotate: input.options.rotateToken === true
        });
    try {
      const helper = nativeCredentialHelper(input.tool, configPath);
      const result =
        input.tool === "codex"
          ? installCodexIntegration({
              gatewayUrl: prepared.gatewayUrl,
              models: prepared.catalog.models.map((model) => {
                const reasoning = catalogReasoning(model.reasoning);
                return {
                  modelId: model.id,
                  ...(reasoning !== undefined ? { reasoning } : {})
                };
              }),
              defaultModel: prepared.catalog.defaultModel,
              profileId: "routekit",
              owner: CODEX_OWNER,
              ...(!noToken ? { auth: { command: helper.command, args: helper.args } } : {}),
              ...(input.options.codexHome !== undefined
                ? { codexHome: input.options.codexHome }
                : {})
            })
          : await installClaudeIntegration({
              gatewayUrl: prepared.gatewayUrl,
              models: prepared.catalog.models.map((model) => model.id),
              owner: CLAUDE_OWNER,
              ...(!noToken ? { apiKeyHelper: nativeCredentialShellCommand(helper) } : {}),
              ...(input.options.claudeConfigDir !== undefined
                ? { claudeConfigDir: input.options.claudeConfigDir }
                : {})
            });
      if (!noToken) {
        await rememberCredential({
          tool: input.tool,
          configPath: result.configPath,
          target: targetId,
          credential
        });
      }
      if (input.context.json) {
        input.context.emit({
          action: result.action,
          configPath: result.configPath,
          credential: noToken ? "external" : "managed",
          ...(credential.token !== undefined ? { tokenRotated: true } : {})
        });
      } else {
        input.context.presenter.success(`${result.action} RouteKit in ${result.configPath}`);
        if (noToken) {
          input.context.presenter.note(
            `no gateway token was issued; configure ${tokenEnvironment(input.tool)} in the client environment`
          );
        } else {
          input.context.presenter.note(
            `the dedicated gateway credential is protected and ${input.tool} retrieves it automatically; no shell secret is required`
          );
          if (credential.token === undefined) {
            input.context.presenter.note(
              "the existing dedicated gateway credential remains in use; pass --rotate-token to issue a replacement"
            );
          }
        }
      }
    } catch (error) {
      if (credential.tokenId !== undefined) {
        await deleteNativeCredential(input.tool, configPath).catch(() => undefined);
        await (await controlFor(targetId))
          .call("tokens.revoke", { id: credential.tokenId })
          .catch(() => undefined);
      }
      throw error;
    }
  }
}

export class UninstallNativeIntegration {
  async execute(input: {
    tool: NativeIntegrationTool;
    home?: string;
  }): Promise<{ removed: boolean; configPath: string }> {
    const configPath =
      input.tool === "codex"
        ? codexIntegrationConfigPath(input.home)
        : claudeIntegrationConfigPath(input.home);
    const existing = getNativeIntegration(input.tool, configPath);
    if (existing !== undefined && existing.tokenRevoked !== true) {
      await revokeToken(existing);
      await markNativeIntegrationTokenRevoked(input.tool, configPath);
    }
    const result =
      input.tool === "codex"
        ? uninstallCodexIntegration({
            ownerId: CODEX_OWNER.id,
            ...(input.home !== undefined ? { codexHome: input.home } : {})
          })
        : await uninstallClaudeIntegration({
            ownerId: CLAUDE_OWNER.id,
            ...(input.home !== undefined ? { claudeConfigDir: input.home } : {})
          });
    await deleteNativeIntegration(input.tool, configPath);
    await deleteNativeCredential(input.tool, configPath);
    return result;
  }
}
