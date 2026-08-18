import { isAbsolute, resolve } from "node:path";

import {
  type CliRuntime,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { readNativeCredential } from "../../adapters/native-credentials.js";
import {
  getNativeIntegration,
  listNativeIntegrations,
  type NativeIntegrationTool
} from "../../adapters/native-integrations.js";
import { cliTryPromise } from "../../cli-session.js";
import { routekitHome } from "../../config.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const makeCredentialShellCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any =>
  Command.make(
    "shell",
    {
      tool: optionalString("tool").pipe(Flag.withDescription("codex or claude"))
    },
    ({ tool }) =>
      Effect.gen(function* () {
        if (tool !== undefined && tool !== "codex" && tool !== "claude") {
          return yield* Effect.fail(new Error("--tool must be codex or claude"));
        }
        const home = routekitHome(runtime.env);
        const entries = listNativeIntegrations({ routekitHome: home }).filter(
          (entry) =>
            entry.tokenRevoked !== true && (tool === undefined || entry.tool === tool)
        );
        const selected = new Map<string, (typeof entries)[number]>();
        for (const entry of entries) selected.set(entry.tool, entry);
        for (const nativeTool of ["codex", "claude"] as const) {
          const entry = selected.get(nativeTool);
          if (entry === undefined) continue;
          const token = yield* cliTryPromise(() =>
            readNativeCredential(entry.tool, entry.configPath, {
              home,
              platform: runtime.platform
            })
          );
          if (token === undefined) continue;
          const name =
            nativeTool === "codex" ? "ROUTEKIT_GATEWAY_TOKEN" : "ANTHROPIC_AUTH_TOKEN";
          runtime.stdout.write(`export ${name}=${shellQuote(token)}\n`);
        }
      })
  ).pipe(Command.withDescription("print native client credentials for shell evaluation"));

export const makeCredentialsCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const get = Command.make(
    "get",
    {
      tool: Flag.string("tool").pipe(Flag.withDescription("codex or claude")),
      configPath: Flag.string("config-path").pipe(
        Flag.withDescription("exact native client configuration path")
      ),
      routekitHome: Flag.string("routekit-home").pipe(
        Flag.withDescription("RouteKit state directory that owns the credential")
      )
    },
    ({ configPath, routekitHome: homeInput, tool }) =>
      Effect.gen(function* () {
        if (tool !== "codex" && tool !== "claude") {
          return yield* Effect.fail(new Error("--tool must be codex or claude"));
        }
        if (!isAbsolute(homeInput)) {
          return yield* Effect.fail(new Error("--routekit-home must be an absolute path"));
        }
        const home = resolve(homeInput);
        const nativeTool = tool as NativeIntegrationTool;
        const entry = getNativeIntegration(nativeTool, configPath, { routekitHome: home });
        if (entry === undefined || entry.tokenRevoked === true) {
          return yield* Effect.fail(
            new Error(`no active RouteKit credential is registered for this ${nativeTool} integration`)
          );
        }
        const token = yield* cliTryPromise(() =>
          readNativeCredential(nativeTool, entry.configPath, {
            home,
            platform: runtime.platform
          })
        );
        if (token === undefined) {
          return yield* Effect.fail(
            new Error(
              `the RouteKit credential for this ${nativeTool} integration is missing; rerun its install command with --rotate-token`
            )
          );
        }
        runtime.stdout.write(`${token}\n`);
      })
  ).pipe(
    Command.withDescription("print one native client credential for a configured integration")
  );

  return Command.make("credential").pipe(
    Command.withDescription("resolve RouteKit-managed native client credentials"),
    Command.withSubcommands([get]),
    Command.unlisted
  );
};
