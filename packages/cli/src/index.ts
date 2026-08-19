#!/usr/bin/env node
/** Executable entrypoint for the independent RouteKit router CLI. */
import {
  CliError,
  commandNames,
  emitJson,
  processCliRuntime,
  renderCliError,
  visibleCommandChildren
} from "@velum-labs/routekit-cli-core";
import { configureBrand, uiStream } from "@velum-labs/routekit-cli-ui";
import { makeRouteKitRuntime, runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { registerCleanup, runCleanups } from "@velum-labs/routekit-runtime/lifecycle";
import { Effect } from "effect";
import {
  CliConfig,
  CliError as EffectCliError,
  Command,
  Flag,
  GlobalFlag
} from "effect/unstable/cli";

import { CliSession, runWithCliSession } from "./cli-session.js";
import { CommandTelemetry } from "./command-telemetry.js";
import { normalizeOptionalFlagValues } from "./adapters/optional-flag-value.js";
import { buildEffectProgram } from "./effect/program.js";
import { notifyIfUpdateAvailable } from "./update-notifier.js";
import { routekitVersion } from "./state.js";
import { assertLocalTarget, setTargetSelection } from "./target.js";

configureBrand({
  name: "routekit",
  tagline: "model routes for coding tools"
});

const LOCAL_ONLY_COMMANDS = new Set(["start", "stop", "setup", "config init"]);

function hasJsonFlag(argv: readonly string[]): boolean {
  const separator = argv.indexOf("--");
  return (separator === -1 ? argv : argv.slice(0, separator)).includes("--json");
}

function targetSelection(argv: readonly string[]): { local: boolean; remote?: string } {
  const separator = argv.indexOf("--");
  const args = separator === -1 ? argv : argv.slice(0, separator);
  let local = false;
  let remote: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--local") local = true;
    if (value === "--remote") {
      remote = args[index + 1];
      index += 1;
    } else if (value?.startsWith("--remote=")) {
      remote = value.slice("--remote=".length);
    }
  }
  return { local, ...(remote !== undefined ? { remote } : {}) };
}

const GLOBAL_VALUE_FLAGS = new Set(["--remote"]);
function selectedCommandPath(program: Command.Command.Any, argv: readonly string[]): string {
  const separator = argv.indexOf("--");
  const args = separator === -1 ? argv : argv.slice(0, separator);
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (GLOBAL_VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    words.push(value);
  }
  const path: string[] = [];
  let current = program;
  for (const word of words) {
    const next = visibleCommandChildren(current).find((child) => commandNames(child).includes(word));
    if (next === undefined) break;
    path.push(next.name);
    current = next;
  }
  return path.join(" ");
}

function shouldNotify(argv: readonly string[]): boolean {
  return (
    !argv.some((arg) => ["--json", "--quiet", "--help", "-h"].includes(arg)) &&
    !argv.some((arg) => ["completion", "__complete", "__self-inspect"].includes(arg)) &&
    !(argv[0] === "token" && argv[1] === "shell") &&
    !(argv[0] === "credential" && argv[1] === "get")
  );
}

function renderError(error: unknown, json: boolean): number {
  if (EffectCliError.isCliError(error)) return 1;
  if (error instanceof CliError) return renderCliError(error, { json });
  const message = error instanceof Error ? error.message : String(error);
  if (json) emitJson({ error: { code: "error", message } });
  else uiStream().write(`error: ${message}\n`);
  return 1;
}

async function main(): Promise<void> {
  const effectRuntime = makeRouteKitRuntime();
  const session = new CliSession(processCliRuntime, undefined, effectRuntime);
  const commandTelemetry = new CommandTelemetry(session, processCliRuntime);
  const program = buildEffectProgram(session, processCliRuntime);
  const rawArgv = process.argv.slice(2);
  const path = selectedCommandPath(program, rawArgv);
  const argv = normalizeOptionalFlagValues(rawArgv, path);
  const json = hasJsonFlag(argv);
  await runWithCliSession(session, async () => {
    setTargetSelection(targetSelection(argv), session);
    const actionOnly = argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg));
    if (!actionOnly && (LOCAL_ONLY_COMMANDS.has(path) || path.startsWith("daemon "))) {
      assertLocalTarget(path);
    }
    commandTelemetry.begin(path);
    const unregisterCancelledTelemetry = registerCleanup(async () => {
      await commandTelemetry.finish("cancelled");
    });
    try {
      const versionFlag = GlobalFlag.action({
        flag: Flag.boolean("version").pipe(
          Flag.withAlias("v"),
          Flag.withDescription("print the RouteKit CLI version")
        ),
        run: () =>
          Effect.sync(() => {
            processCliRuntime.stdout.write(`@velum-labs/routekit ${routekitVersion()}\n`);
          })
      });
      const builtIns = [GlobalFlag.Help, versionFlag, GlobalFlag.LogLevel];
      const run = Command.runWith(program, { version: routekitVersion(), renderErrors: true })(argv).pipe(
        Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns }))
      );
      await runRouteKitEffect(run, effectRuntime);
      await commandTelemetry.finish("success");
      if (process.exitCode === undefined && shouldNotify(argv)) await notifyIfUpdateAvailable(routekitVersion());
    } catch (error) {
      await commandTelemetry.finish(EffectCliError.isCliError(error) ? "usage_error" : "command_error");
      process.exitCode = renderError(error, json);
    } finally {
      unregisterCancelledTelemetry();
      await runCleanups();
      await effectRuntime.dispose();
    }
  });
}

void main();
