import {
  type CliRuntime,
  type CommandContext,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  InstallNativeIntegration,
  UninstallNativeIntegration
} from "../../services/native-integration/service.js";
import { routekitRoot } from "../root-command.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

function reportUninstall(
  context: CommandContext,
  tool: "codex" | "claude",
  result: { removed: boolean; configPath: string }
): void {
  if (context.json) context.emit(result);
  else if (result.removed) context.presenter.success(`removed RouteKit from ${result.configPath}`);
  else {
    context.presenter.note(
      tool === "codex"
        ? `no RouteKit block found in ${result.configPath}`
        : `no RouteKit settings found in ${result.configPath}`
    );
  }
}

export function makeCodexIntegrationCommands(
  runtime: CliRuntime = processCliRuntime
): ReadonlyArray<Command.Command.Any> {
  const installService = new InstallNativeIntegration();
  const uninstallService = new UninstallNativeIntegration();
  const install = Command.make(
    "install",
    {
      codexHome: optionalString("codex-home").pipe(
        Flag.withDescription("Codex home directory")
      ),
      rotateToken: Flag.boolean("rotate-token").pipe(
        Flag.withDescription("replace the dedicated gateway token")
      ),
      noToken: Flag.boolean("no-token").pipe(
        Flag.withDescription("install configuration without issuing or changing a gateway token")
      )
    },
    ({ codexHome, noToken, rotateToken }) =>
      Effect.gen(function* () {
        yield* installService.execute({
          tool: "codex",
          options: {
            ...(codexHome !== undefined ? { codexHome } : {}),
            ...(rotateToken ? { rotateToken } : {}),
            token: !noToken
          },
          context: contextForFlags(yield* routekitRoot, runtime)
        });
      })
  ).pipe(
    Command.withDescription("install one RouteKit Codex profile with a gateway-backed model picker")
  );
  const uninstall = Command.make(
    "uninstall",
    {
      codexHome: optionalString("codex-home").pipe(
        Flag.withDescription("Codex home directory")
      )
    },
    ({ codexHome }) =>
      Effect.gen(function* () {
        const result = yield* uninstallService.execute({
          tool: "codex",
          ...(codexHome !== undefined ? { home: codexHome } : {})
        });
        reportUninstall(
          contextForFlags(yield* routekitRoot, runtime),
          "codex",
          result
        );
      })
  ).pipe(
    Command.withDescription("remove RouteKit-owned Codex configuration and its dedicated token")
  );
  return [install, uninstall];
}

export function makeClaudeIntegrationCommands(
  runtime: CliRuntime = processCliRuntime
): ReadonlyArray<Command.Command.Any> {
  const installService = new InstallNativeIntegration();
  const uninstallService = new UninstallNativeIntegration();
  const install = Command.make(
    "install",
    {
      claudeConfigDir: optionalString("claude-config-dir").pipe(
        Flag.withDescription("Claude Code configuration directory")
      ),
      rotateToken: Flag.boolean("rotate-token").pipe(
        Flag.withDescription("replace the dedicated gateway token")
      ),
      noToken: Flag.boolean("no-token").pipe(
        Flag.withDescription("install configuration without issuing or changing a gateway token")
      )
    },
    ({ claudeConfigDir, noToken, rotateToken }) =>
      Effect.gen(function* () {
        yield* installService.execute({
          tool: "claude",
          options: {
            ...(claudeConfigDir !== undefined ? { claudeConfigDir } : {}),
            ...(rotateToken ? { rotateToken } : {}),
            token: !noToken
          },
          context: contextForFlags(yield* routekitRoot, runtime)
        });
      })
  ).pipe(Command.withDescription("install RouteKit-owned Claude Code gateway settings"));
  const uninstall = Command.make(
    "uninstall",
    {
      claudeConfigDir: optionalString("claude-config-dir").pipe(
        Flag.withDescription("Claude Code configuration directory")
      )
    },
    ({ claudeConfigDir }) =>
      Effect.gen(function* () {
        const result = yield* uninstallService.execute({
          tool: "claude",
          ...(claudeConfigDir !== undefined ? { home: claudeConfigDir } : {})
        });
        reportUninstall(
          contextForFlags(yield* routekitRoot, runtime),
          "claude",
          result
        );
      })
  ).pipe(
    Command.withDescription("remove RouteKit-owned Claude Code settings and its dedicated token")
  );
  return [install, uninstall];
}
