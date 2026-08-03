import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { routekitHome } from "@velum-labs/routekit-config";

import type { NativeIntegrationTool } from "./native-integrations.js";

export type NativeCredentialHelper = {
  command: string;
  args: string[];
  shellCommand: string;
};

type NativeCredentialHelperOptions = {
  platform?: NodeJS.Platform;
  cliEntrypoint?: string;
  execPath?: string;
};

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsQuote(value: string): string {
  if (!/[\s"&<>|^()%!]/.test(value)) return value;
  return `"${value.replaceAll('"', '""').replaceAll("%", "%%")}"`;
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
  const quote = (options.platform ?? process.platform) === "win32" ? windowsQuote : posixQuote;
  return {
    command,
    args,
    shellCommand: [command, ...args].map(quote).join(" ")
  };
}
