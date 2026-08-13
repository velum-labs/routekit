#!/usr/bin/env node
/** Executable entrypoint for the independent RouteKit router CLI. */
import { CliError, emitJson, renderCliError } from "@velum-labs/routekit-cli-core";
import { configureBrand, uiStream } from "@velum-labs/routekit-cli-ui";
import { registerCleanup, runCleanups } from "@velum-labs/routekit-runtime";
import { CommanderError } from "commander";

import { buildProgram, routekitVersion } from "./cli.js";
import { runWithCliSession } from "./cli-session.js";
import { notifyIfUpdateAvailable } from "./update-notifier.js";

configureBrand({
  name: "routekit",
  tagline: "model routes for coding tools"
});

const GLOBAL_VALUE_OPTIONS = new Set(["--remote"]);
const GLOBAL_BOOLEAN_OPTIONS = new Set(["--json", "--no-input", "--yes", "--quiet", "--local"]);

/**
 * Keep global output/target flags ergonomic after a subcommand
 * (`routekit start --json`) while preserving everything after `--` for the
 * launched coding tool.
 */
function normalizeGlobalOptions(argv: readonly string[]): string[] {
  const prefix = argv.slice(0, 2);
  const args = argv.slice(2);
  const separator = args.indexOf("--");
  const routekitArgs = separator === -1 ? args : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator);
  const globals: string[] = [];
  const command: string[] = [];
  for (let index = 0; index < routekitArgs.length; index += 1) {
    const arg = routekitArgs[index]!;
    if (GLOBAL_BOOLEAN_OPTIONS.has(arg)) {
      globals.push(arg);
      continue;
    }
    if (GLOBAL_VALUE_OPTIONS.has(arg)) {
      const value = routekitArgs[index + 1];
      globals.push(arg);
      if (value !== undefined) {
        globals.push(value);
        index += 1;
      }
      continue;
    }
    command.push(arg);
  }
  return [...prefix, ...globals, ...command, ...passthrough];
}

function hasJsonFlag(argv: readonly string[]): boolean {
  const separator = argv.indexOf("--");
  return (separator === -1 ? argv : argv.slice(0, separator)).includes("--json");
}

function renderError(error: unknown, json: boolean): number {
  if (error instanceof CliError) return renderCliError(error, { json });
  if (error instanceof CommanderError) return error.exitCode;
  const message = error instanceof Error ? error.message : String(error);
  if (json) emitJson({ error: { code: "error", message } });
  else uiStream().write(`error: ${message}\n`);
  return 1;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await runWithCliSession(program.session, async () => {
    const json = hasJsonFlag(process.argv.slice(2));
    program.exitOverride();
    const unregisterCancelledTelemetry = registerCleanup(async () => {
      await program.commandTelemetry.finish("cancelled");
    });
    try {
      if (process.argv.length <= 2) program.outputHelp();
      else {
        await program.parseAsync(normalizeGlobalOptions(process.argv));
        const args = process.argv.slice(2);
        if (
          process.exitCode === undefined &&
          !args.some((arg) => ["--json", "--quiet", "--help", "-h"].includes(arg)) &&
          !args.some((arg) => ["completion", "__complete", "__self-inspect"].includes(arg)) &&
          !(args[0] === "token" && args[1] === "shell") &&
          !(args[0] === "credential" && args[1] === "get")
        ) {
          await notifyIfUpdateAvailable(routekitVersion());
        }
      }
    } catch (error) {
      const exitKind = error instanceof CommanderError ? "usage_error" : "command_error";
      await program.commandTelemetry.finish(exitKind);
      process.exitCode = renderError(error, json);
    } finally {
      unregisterCancelledTelemetry();
      await runCleanups();
      await program.session.dispose();
    }
  });
}

void main();
