import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { routekitHome } from "@velum-labs/routekit-config";
import { quote } from "shell-quote";

import type { NativeIntegrationTool } from "./native-integrations.js";

export type NativeCredentialHelper = {
  command: string;
  args: string[];
};

type NativeCredentialHelperOptions = {
  cliEntrypoint?: string;
  execPath?: string;
};

/**
 * Serialize a helper for clients that only accept a POSIX shell command
 * string. Keep this separate from the argument-vector form used by Codex so
 * platforms with incompatible shell grammars fail explicitly rather than
 * receiving an incorrectly quoted command.
 */
export function nativeCredentialShellCommand(
  helper: NativeCredentialHelper,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    throw new Error(
      "Claude apiKeyHelper credential integration is not supported on Windows; use --no-token"
    );
  }
  return quote([helper.command, ...helper.args]);
}

/**
 * Build an absolute, PATH-independent invocation of this RouteKit CLI. Native
 * clients can therefore pull a token from the protected store even when they
 * were launched by an IDE, Finder, launchd, or another non-login process.
 */
export function nativeCredentialHelper(
  tool: NativeIntegrationTool,
  configPath: string,
  options: NativeCredentialHelperOptions = {}
): NativeCredentialHelper {
  const fallbackEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  const runningEntrypoint = process.argv[1];
  const runningName = runningEntrypoint === undefined ? "" : basename(runningEntrypoint);
  const cliEntrypoint = resolve(
    options.cliEntrypoint ??
      (runningName === "routekit" || runningName === "index.js" || runningName === "index.ts"
        ? runningEntrypoint!
        : fallbackEntrypoint)
  );
  const args = [
    cliEntrypoint,
    "credential",
    "get",
    "--tool",
    tool,
    "--config-path",
    resolve(configPath),
    "--routekit-home",
    resolve(routekitHome())
  ];
  const command = options.execPath ?? process.execPath;
  return {
    command,
    args
  };
}
