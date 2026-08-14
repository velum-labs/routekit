import { hostname as osHostname } from "node:os";

import type { CommandContext } from "@velum-labs/routekit-cli-core";
import type { ModelReasoningCapabilities } from "@velum-labs/routekit-contracts";
import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import type { ClaudeInstallOwner, CodexInstallOwner } from "@velum-labs/routekit-tool-registry";
import {
  claudeIntegrationConfigPath,
  codexIntegrationConfigPath,
  installClaudeIntegration,
  installCodexIntegration,
  uninstallClaudeIntegration,
  uninstallCodexIntegration
} from "@velum-labs/routekit-tool-registry";
import { Effect } from "effect";

import { fetchLiveCatalog } from "../catalog.js";
import { activeCliSession, cliTry, cliTryPromise } from "../cli-session.js";
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

function controlFor(target: NativeIntegrationTarget) {
  return cliTryPromise(async () => {
    if (target.kind === "local") return await routekitClient();
    const remote = activeCliSession().remotes.registry.find(target.name);
    if (remote === undefined) {
      throw new RouteKitFailure({
        message: `the RouteKit remote recorded for this native client integration no longer exists: ${target.name}; re-add it before rotating or uninstalling`
      });
    }
    return remoteControlClient(remote);
  });
}

function revokeToken(entry: NativeIntegration) {
  return Effect.gen(function* () {
    if (entry.tokenRevoked === true) return;
    const client = yield* controlFor(entry.target);
    yield* client.call("tokens.revoke", { id: entry.tokenId });
  });
}

function prepareCredential(input: {
  tool: NativeIntegrationTool;
  configPath: string;
  target: NativeIntegrationTarget;
  rotate: boolean;
}) {
  return Effect.gen(function* () {
    const existing = getNativeIntegration(input.tool, input.configPath);
    if (existing !== undefined && !sameTarget(existing.target, input.target) && !input.rotate) {
      return yield* new RouteKitFailure({
        message: `this ${input.tool} integration targets a different RouteKit gateway; rerun with --rotate-token to replace its credential`
      });
    }
    if (existing?.tokenRevoked === true && !input.rotate) {
      return yield* new RouteKitFailure({
        message: `the dedicated ${input.tool} gateway token is already revoked; rerun with --rotate-token to issue a replacement`
      });
    }
    if (existing !== undefined && existing.tokenRevoked !== true && !input.rotate) {
      const stored = yield* cliTryPromise(() => readNativeCredential(input.tool, input.configPath));
      if (stored !== undefined) return { existing };
      return yield* new RouteKitFailure({
        message:
          `the managed credential for this ${input.tool} integration is missing; ` +
          "rerun with --rotate-token to issue a replacement"
      });
    }
    const client = yield* controlFor(input.target);
    const issued = yield* client.call("tokens.issue", {
      label: tokenLabel(input.tool),
      plane: "data",
      createdBy: `native-client-install:${input.tool}`
    });
    if (existing !== undefined && existing.tokenRevoked !== true) {
      yield* Effect.gen(function* () {
        yield* revokeToken(existing);
        yield* cliTryPromise(() =>
          markNativeIntegrationTokenRevoked(existing.tool, existing.configPath)
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* controlFor(input.target).pipe(
              Effect.flatMap((targetClient) =>
                targetClient.call("tokens.revoke", { id: issued.id })
              ),
              Effect.ignore
            );
            return yield* toRouteKitFailure(error);
          })
        )
      );
    }
    return { existing, token: issued.token, tokenId: issued.id };
  });
}

function rememberCredential(input: {
  tool: NativeIntegrationTool;
  configPath: string;
  target: NativeIntegrationTarget;
  credential: { existing?: NativeIntegration; token?: string; tokenId?: string };
}) {
  return Effect.gen(function* () {
    if (input.credential.token !== undefined) {
      yield* cliTryPromise(() =>
        writeNativeCredential(input.tool, input.configPath, input.credential.token!)
      );
    }
    if (input.credential.tokenId === undefined && input.credential.existing === undefined) return;
    yield* cliTryPromise(() =>
      putNativeIntegration({
        tool: input.tool,
        configPath: input.configPath,
        target: input.target,
        tokenId: input.credential.tokenId ?? input.credential.existing!.tokenId,
        ...(input.credential.tokenId === undefined &&
        input.credential.existing?.tokenRevoked === true
          ? { tokenRevoked: true }
          : {})
      })
    );
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
  execute(input: InstallNativeIntegrationInput) {
    return Effect.gen(function* () {
      const noToken = input.options.token === false;
      if (noToken && input.options.rotateToken === true) {
        return yield* new RouteKitFailure({
          message: "--no-token cannot be combined with --rotate-token"
        });
      }
      const target = yield* cliTryPromise(() => resolveTarget());
      const targetId = targetIdentity(target);
      const configPath =
        input.tool === "codex"
          ? codexIntegrationConfigPath(input.options.codexHome)
          : claudeIntegrationConfigPath(input.options.claudeConfigDir);
      const prepared =
        target.kind === "remote"
          ? {
              gatewayUrl: target.remote.gatewayUrl,
              catalog: yield* fetchLiveCatalog(target.remote.gatewayUrl, {
                authToken: target.authToken
              })
            }
          : yield* Effect.gen(function* () {
              const client = yield* cliTryPromise(() => routekitClient());
              const [daemon, catalog] = yield* Effect.all(
                [client.call("daemon.status", {}), client.call("models.list", {})],
                { concurrency: "unbounded" }
              );
              return { gatewayUrl: daemon.dataUrl, catalog };
            });
      if (noToken) {
        yield* cliTry(() => assertNoTokenTarget(input.tool, configPath, targetId));
      }
      const credential: {
        existing?: NativeIntegration;
        token?: string;
        tokenId?: string;
      } = noToken
        ? {}
        : yield* prepareCredential({
            tool: input.tool,
            configPath,
            target: targetId,
            rotate: input.options.rotateToken === true
          });
      yield* Effect.gen(function* () {
        const helper = nativeCredentialHelper(input.tool, configPath);
        const result =
          input.tool === "codex"
            ? yield* cliTry(() =>
                installCodexIntegration({
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
              )
            : yield* cliTryPromise(() =>
                installClaudeIntegration({
                  gatewayUrl: prepared.gatewayUrl,
                  models: prepared.catalog.models.map((model) => model.id),
                  owner: CLAUDE_OWNER,
                  ...(!noToken ? { apiKeyHelper: nativeCredentialShellCommand(helper) } : {}),
                  ...(input.options.claudeConfigDir !== undefined
                    ? { claudeConfigDir: input.options.claudeConfigDir }
                    : {})
                })
              );
        if (!noToken) {
          yield* rememberCredential({
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
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const tokenId = credential.tokenId;
            if (tokenId !== undefined) {
              yield* cliTryPromise(() => deleteNativeCredential(input.tool, configPath)).pipe(
                Effect.ignore
              );
              yield* controlFor(targetId).pipe(
                Effect.flatMap((client) => client.call("tokens.revoke", { id: tokenId })),
                Effect.ignore
              );
            }
            return yield* toRouteKitFailure(error);
          })
        )
      );
    });
  }
}

export class UninstallNativeIntegration {
  execute(input: { tool: NativeIntegrationTool; home?: string }) {
    return Effect.gen(function* () {
      const configPath =
        input.tool === "codex"
          ? codexIntegrationConfigPath(input.home)
          : claudeIntegrationConfigPath(input.home);
      const existing = getNativeIntegration(input.tool, configPath);
      if (existing !== undefined && existing.tokenRevoked !== true) {
        yield* revokeToken(existing);
        yield* cliTryPromise(() => markNativeIntegrationTokenRevoked(input.tool, configPath));
      }
      const result =
        input.tool === "codex"
          ? yield* cliTry(() =>
              uninstallCodexIntegration({
                ownerId: CODEX_OWNER.id,
                ...(input.home !== undefined ? { codexHome: input.home } : {})
              })
            )
          : yield* cliTryPromise(() =>
              uninstallClaudeIntegration({
                ownerId: CLAUDE_OWNER.id,
                ...(input.home !== undefined ? { claudeConfigDir: input.home } : {})
              })
            );
      yield* cliTryPromise(() => deleteNativeIntegration(input.tool, configPath));
      yield* cliTryPromise(() => deleteNativeCredential(input.tool, configPath));
      return result;
    });
  }
}
