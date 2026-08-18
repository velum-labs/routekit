import { resolve } from "node:path";

import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { LaunchPreparation } from "@velum-labs/routekit-control";
import { commandOnPath } from "@velum-labs/routekit-runtime/environment";
import { isLoopbackHost, trimTrailingSlashes } from "@velum-labs/routekit-runtime/network";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { launchTool, routekitToolRegistry } from "../../adapters/launch.js";
import { cliTry, cliTryPromise } from "../../cli-session.js";
import { routekitClient } from "../../client.js";
import { isLaunchToolId, type LaunchToolId } from "../../launch-support.js";
import { resolveTarget } from "../../target.js";
import {
  makeClaudeIntegrationCommands,
  makeCodexIntegrationCommands
} from "./install.js";
import { routekitRoot } from "../root-command.js";

type LauncherPreparation = {
  tool: LaunchToolId | "opencode";
  gatewayUrl: string;
  authToken?: string;
  model?: string;
  env: Record<string, string>;
  codexSelection?: LaunchPreparation["codexSelection"];
};

const optionalStringFlag = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );
const optionalStringArgument = (name: string) =>
  Argument.string(name).pipe(
    Argument.optional,
    Argument.map(Option.getOrUndefined)
  );

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

function launcherPositionals(
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
  return modelCameAfterSeparator
    ? { model: undefined, toolArgs: forwarded }
    : { model, toolArgs: forwarded };
}

export const makeLauncherCommands = (
  runtime: CliRuntime = processCliRuntime
): ReadonlyArray<Command.Command.Any> =>
  routekitToolRegistry
    .list()
    .filter((entry) => isLaunchToolId(entry.id))
    .map((integration) => {
      const command = Command.make(
        integration.id,
        {
          model: optionalStringArgument("model").pipe(
            Argument.withDescription("live namespaced provider/model id")
          ),
          toolArgs: Argument.string("tool-args").pipe(
            Argument.variadic({ min: 0 }),
            Argument.withDescription(`arguments passed to ${integration.displayName}`)
          ),
          gatewayUrl: optionalStringFlag("gateway-url").pipe(
            Flag.withDescription("connect to an existing RouteKit gateway")
          ),
          effort: optionalStringFlag("effort").pipe(
            Flag.withDescription("opaque reasoning effort for the selected model")
          ),
          authToken: optionalStringFlag("auth-token").pipe(
            Flag.withDescription("gateway authentication token")
          ),
          authTokenEnv: optionalStringFlag("auth-token-env").pipe(
            Flag.withDescription("read gateway authentication token from an environment variable")
          ),
          cwd: optionalStringFlag("cwd").pipe(
            Flag.withDescription("tool working directory")
          )
        },
        (options) =>
          Effect.gen(function* () {
            const globals = yield* routekitRoot;
            if (globals.json) {
              return yield* Effect.fail(
                new Error(`\`${integration.id}\` is interactive and does not support --json`)
              );
            }
            if (integration.binary !== undefined && !commandOnPath(integration.binary)) {
              return yield* Effect.fail(
                new Error(
                  `routekit preflight failed: "${integration.binary}" was not found on PATH — ${
                    integration.installHint ?? `install ${integration.binary}`
                  }`
                )
              );
            }
            const positionals = launcherPositionals(options.model, options.toolArgs);
            const model = positionals.model;
            const toolArgs = [...positionals.toolArgs];
            const explicitlySelectedModel = model !== undefined;
            const cwd = resolve(options.cwd ?? ".");
            const externalToken =
              options.authTokenEnv !== undefined
                ? runtime.env[options.authTokenEnv]
                : options.authToken;
            if (options.authTokenEnv !== undefined && externalToken === undefined) {
              return yield* Effect.fail(
                new Error(`credential environment variable is not set: ${options.authTokenEnv}`)
              );
            }
            if (options.gatewayUrl !== undefined && externalToken !== undefined) {
              const external = new URL(options.gatewayUrl);
              if (external.protocol !== "https:" && !isLoopbackHost(external.hostname)) {
                return yield* Effect.fail(
                  new Error("authenticated external gateways require HTTPS")
                );
              }
            }
            const tool = integration.id as LaunchToolId;
            const prepared =
              options.gatewayUrl === undefined
                ? yield* resolveLauncherPreparationEffect({
                    tool,
                    ...(model !== undefined ? { model } : {}),
                    cwd
                  })
                : undefined;
            const result = yield* launchTool({
              tool,
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
            process.exitCode = result;
          })
      ).pipe(
        Command.withDescription(
          integration.id === "codex"
            ? "launch Codex through RouteKit (Responses-only; best-effort model filtering)"
            : `launch ${integration.displayName} through RouteKit`
        )
      );
      const subcommands =
        integration.id === "codex"
          ? makeCodexIntegrationCommands(runtime)
          : integration.id === "claude"
            ? makeClaudeIntegrationCommands(runtime)
            : [];
      return subcommands.length === 0
        ? command
        : command.pipe(Command.withSubcommands(subcommands));
    });
