import { resolve } from "node:path";

import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { LaunchPreparation } from "@velum-labs/routekit-control";
import { commandOnPath, isLoopbackHost, trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";
import { Effect } from "effect";
import { cliTry, cliTryPromise, runCliEffect } from "../cli-session.js";
import { routekitClient } from "../client.js";
import { launchTool, routekitToolRegistry } from "../launch.js";
import { isLaunchToolId, type LaunchToolId } from "../launch-support.js";
import { resolveTarget } from "../target.js";
import { registerClaudeIntegration, registerCodexIntegration } from "./install.js";

type LauncherPreparation = {
  tool: LaunchToolId | "opencode";
  gatewayUrl: string;
  authToken?: string;
  model?: string;
  env: Record<string, string>;
  codexSelection?: LaunchPreparation["codexSelection"];
};

export function resolveLauncherPreparationEffect(
  input: { tool: LaunchToolId; model?: string; cwd: string },
  dependencies: {
    resolve?: typeof resolveTarget;
    client?: typeof routekitClient;
  } = {}
) {
  return Effect.gen(function* () {
    const target = yield* cliTryPromise(() => (dependencies.resolve ?? resolveTarget)());
    if (target.kind === "remote") {
      const prepared: LauncherPreparation = {
        tool: input.tool,
        gatewayUrl: target.remote.gatewayUrl,
        authToken: target.authToken,
        ...(input.model !== undefined ? { model: input.model } : {}),
        env: {}
      };
      return prepared;
    }
    const client = yield* dependencies.client ?? routekitClient;
    const prepared = yield* client.call("launcher.prepare", {
      tool: input.tool,
      ...(input.model !== undefined ? { model: input.model } : {}),
      cwd: input.cwd
    });
    if (prepared.tool !== input.tool) {
      return yield* cliTry(() => {
        throw new Error(
          `launcher preparation returned ${prepared.tool} for requested tool ${input.tool}`
        );
      });
    }
    return { ...prepared, tool: input.tool };
  });
}

export async function resolveLauncherPreparation(
  input: { tool: LaunchToolId; model?: string; cwd: string },
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
  codexSelection?: LaunchPreparation["codexSelection"];
}> {
  return await runCliEffect(resolveLauncherPreparationEffect(input, dependencies));
}

/**
 * Commander assigns the first positional argument after `--` to `[model]`.
 * For launcher commands, however, everything after `--` belongs to the native
 * client.  Restore that boundary so a native flag such as `-p` is never
 * mistaken for a RouteKit model.
 */
function launcherPositionals(
  _command: Command,
  model: string | undefined,
  toolArgs: readonly string[]
): { model: string | undefined; toolArgs: readonly string[] } {
  const separator = process.argv.lastIndexOf("--");
  if (separator < 0) return { model, toolArgs };

  const forwarded = process.argv.slice(separator + 1);
  const modelCameAfterSeparator =
    forwarded.length > 0 &&
    model === forwarded[0] &&
    toolArgs.length === forwarded.length - 1 &&
    toolArgs.every((argument, index) => argument === forwarded[index + 1]);
  if (!modelCameAfterSeparator) return { model, toolArgs: forwarded };
  return { model: undefined, toolArgs: forwarded };
}

export function registerLaunchers(program: Command, runtime: CliRuntime = processCliRuntime): void {
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
      .option("--cwd <dir>", "tool working directory");
    if (integration.id === "codex") registerCodexIntegration(command, runtime);
    if (integration.id === "claude") registerClaudeIntegration(command, runtime);
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
        },
        actionCommand: Command
      ) => {
        const positionals = launcherPositionals(actionCommand, model, toolArgs);
        model = positionals.model;
        const explicitlySelectedModel = model !== undefined;
        toolArgs = [...positionals.toolArgs];
        if (contextFor(actionCommand, runtime).json) {
          throw new Error(`\`${integration.id}\` is interactive and does not support --json`);
        }
        if (integration.binary !== undefined && !commandOnPath(integration.binary)) {
          throw new Error(
            `routekit preflight failed: "${integration.binary}" was not found on PATH — ` +
              (integration.installHint ?? `install ${integration.binary}`)
          );
        }
        const cwd = resolve(options.cwd ?? ".");
        const externalToken =
          options.authTokenEnv !== undefined
            ? runtime.env[options.authTokenEnv]
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
        const result = await runCliEffect(
          Effect.gen(function* () {
            const prepared =
              options.gatewayUrl === undefined
                ? yield* resolveLauncherPreparationEffect({
                    tool,
                    ...(model !== undefined ? { model } : {}),
                    cwd
                  })
                : undefined;
            return yield* launchTool({
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
              ...(integration.id === "codex"
                ? {
                    modelSelection: explicitlySelectedModel
                      ? ("explicit" as const)
                      : ("implicit" as const),
                    ...(prepared?.codexSelection !== undefined
                      ? { preparedCodexSelection: prepared.codexSelection }
                      : {})
                  }
                : {}),
              ...(options.effort !== undefined ? { effort: options.effort } : {}),
              args: toolArgs,
              cwd,
              ...((options.gatewayUrl !== undefined ? externalToken : prepared?.authToken) !==
              undefined
                ? {
                    authToken:
                      options.gatewayUrl !== undefined ? externalToken : prepared?.authToken
                  }
                : {})
            });
          })
        );
        process.exitCode = result;
      }
    );
  }
}
