import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { runCliEffect } from "../cli-session.js";
import { InstallNativeIntegration, UninstallNativeIntegration } from "../use-cases/install.js";

function reportUninstall(
  context: ReturnType<typeof contextFor>,
  tool: "codex" | "claude",
  result: { removed: boolean; configPath: string }
): void {
  if (context.json) context.emit(result);
  else if (result.removed) context.presenter.success(`removed RouteKit from ${result.configPath}`);
  else
    context.presenter.note(
      tool === "codex"
        ? `no RouteKit block found in ${result.configPath}`
        : `no RouteKit settings found in ${result.configPath}`
    );
}

export function registerCodexIntegration(
  codex: Command,
  runtime: CliRuntime = processCliRuntime
): void {
  const install = new InstallNativeIntegration();
  const uninstall = new UninstallNativeIntegration();
  codex
    .command("install")
    .description("install one RouteKit Codex profile with a gateway-backed model picker")
    .option("--codex-home <dir>", "Codex home directory")
    .option("--rotate-token", "replace the dedicated gateway token")
    .option("--no-token", "install configuration without issuing or changing a gateway token")
    .action(
      async (
        options: { codexHome?: string; rotateToken?: boolean; token?: boolean },
        command: Command
      ) =>
        await runCliEffect(
          install.execute({
            tool: "codex",
            options,
            context: contextFor(command, runtime)
          })
        )
    );
  codex
    .command("uninstall")
    .description("remove RouteKit-owned Codex configuration and its dedicated token")
    .option("--codex-home <dir>", "Codex home directory")
    .action(async (options: { codexHome?: string }, command: Command) => {
      const result = await runCliEffect(
        uninstall.execute({
          tool: "codex",
          ...(options.codexHome !== undefined ? { home: options.codexHome } : {})
        })
      );
      reportUninstall(contextFor(command, runtime), "codex", result);
    });
}

export function registerClaudeIntegration(
  claude: Command,
  runtime: CliRuntime = processCliRuntime
): void {
  const install = new InstallNativeIntegration();
  const uninstall = new UninstallNativeIntegration();
  claude
    .command("install")
    .description("install RouteKit-owned Claude Code gateway settings")
    .option("--claude-config-dir <dir>", "Claude Code configuration directory")
    .option("--rotate-token", "replace the dedicated gateway token")
    .option("--no-token", "install configuration without issuing or changing a gateway token")
    .action(
      async (
        options: {
          claudeConfigDir?: string;
          rotateToken?: boolean;
          token?: boolean;
        },
        command: Command
      ) =>
        await runCliEffect(
          install.execute({
            tool: "claude",
            options,
            context: contextFor(command, runtime)
          })
        )
    );
  claude
    .command("uninstall")
    .description("remove RouteKit-owned Claude Code settings and its dedicated token")
    .option("--claude-config-dir <dir>", "Claude Code configuration directory")
    .action(async (options: { claudeConfigDir?: string }, command: Command) => {
      const result = await runCliEffect(
        uninstall.execute({
          tool: "claude",
          ...(options.claudeConfigDir !== undefined ? { home: options.claudeConfigDir } : {})
        })
      );
      reportUninstall(contextFor(command, runtime), "claude", result);
    });
}
