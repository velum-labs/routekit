import { isAbsolute, resolve } from "node:path";
import type { CliRuntime } from "@velum-labs/routekit-cli-core";
import { processCliRuntime } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { routekitHome } from "../config.js";
import { readNativeCredential } from "../native-credentials.js";
import {
  getNativeIntegration,
  listNativeIntegrations,
  type NativeIntegrationTool
} from "../native-integrations.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function registerCredentialShell(
  token: Command,
  runtime: CliRuntime = processCliRuntime
): void {
  token
    .command("shell")
    .description("print native client credentials for shell evaluation")
    .option("--tool <tool>", "codex or claude")
    .action(async (options: { tool?: string }) => {
      if (options.tool !== undefined && options.tool !== "codex" && options.tool !== "claude") {
        throw new Error("--tool must be codex or claude");
      }
      const home = routekitHome(runtime.env);
      const entries = listNativeIntegrations({ routekitHome: home }).filter(
        (entry) =>
          entry.tokenRevoked !== true && (options.tool === undefined || entry.tool === options.tool)
      );
      const selected = new Map<string, (typeof entries)[number]>();
      for (const entry of entries) selected.set(entry.tool, entry);
      for (const tool of ["codex", "claude"] as const) {
        const entry = selected.get(tool);
        if (entry === undefined) continue;
        const token = await readNativeCredential(entry.tool, entry.configPath, {
          home,
          platform: runtime.platform
        });
        if (token === undefined) continue;
        const name = tool === "codex" ? "ROUTEKIT_GATEWAY_TOKEN" : "ANTHROPIC_AUTH_TOKEN";
        runtime.stdout.write(`export ${name}=${shellQuote(token)}\n`);
      }
    });
}

export function registerCredentials(
  program: Command,
  runtime: CliRuntime = processCliRuntime
): void {
  const credential = program
    .command("credential", { hidden: true })
    .description("resolve RouteKit-managed native client credentials");

  credential
    .command("get")
    .description("print one native client credential for a configured integration")
    .requiredOption("--tool <tool>", "codex or claude")
    .requiredOption("--config-path <path>", "exact native client configuration path")
    .requiredOption("--routekit-home <path>", "RouteKit state directory that owns the credential")
    .action(async (options: { tool: string; configPath: string; routekitHome: string }) => {
      if (options.tool !== "codex" && options.tool !== "claude") {
        throw new Error("--tool must be codex or claude");
      }
      if (!isAbsolute(options.routekitHome)) {
        throw new Error("--routekit-home must be an absolute path");
      }
      const routekitHome = resolve(options.routekitHome);
      const tool = options.tool as NativeIntegrationTool;
      const entry = getNativeIntegration(tool, options.configPath, { routekitHome });
      if (entry === undefined || entry.tokenRevoked === true) {
        throw new Error(`no active RouteKit credential is registered for this ${tool} integration`);
      }
      const token = await readNativeCredential(tool, entry.configPath, {
        home: routekitHome,
        platform: runtime.platform
      });
      if (token === undefined) {
        throw new Error(
          `the RouteKit credential for this ${tool} integration is missing; rerun its install command with --rotate-token`
        );
      }
      runtime.stdout.write(`${token}\n`);
    });
}
