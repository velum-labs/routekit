import {
  type CliRuntime,
  contextFor,
  immutableCliRuntime,
  processCliRuntime,
  readPackageVersion
} from "@velum-labs/routekit-cli-core";
import { Command } from "commander";
import { CliSession, runWithCliSession } from "./cli-session.js";
import { CommandTelemetry } from "./command-telemetry.js";
import { registerCommands } from "./commands/index.js";

export type RouteKitProgram = Command & {
  readonly commandTelemetry: CommandTelemetry;
  readonly runtime: CliRuntime;
  readonly session: CliSession;
};

export function routekitVersion(): string {
  return readPackageVersion(import.meta.url);
}

export function buildProgram(runtimeInput: CliRuntime = processCliRuntime): RouteKitProgram {
  const runtime = immutableCliRuntime(runtimeInput);
  const session = new CliSession(runtime);
  const commandTelemetry = new CommandTelemetry(session, runtime);
  const version = routekitVersion();
  const program = new Command()
    .name("routekit")
    .description("configure and run model routes for coding tools")
    .version(`@velum-labs/routekit ${version}`, "-v, --version", "print the RouteKit CLI version")
    .enablePositionalOptions();
  program.hook("preAction", (_command, actionCommand) => {
    const path: string[] = [];
    for (
      let current: Command | null = actionCommand;
      current?.parent !== null;
      current = current.parent
    ) {
      path.unshift(current.name());
    }
    commandTelemetry.begin(path.join(" "));
  });
  program.hook("postAction", async () => {
    await commandTelemetry.finish("success");
  });
  registerCommands(program, session, runtime);
  program.addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  routekit setup",
      "  routekit accounts login codex --name work",
      "  routekit start",
      "  routekit status --watch",
      "  routekit stop",
      "  routekit usage --watch 10",
      "  routekit models list --provider openai"
    ].join("\n")
  );
  program
    .command("version")
    .description("show the RouteKit CLI version")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      if (ctx.json) ctx.emit({ package: "@velum-labs/routekit", version });
      else runtime.stdout.write(`@velum-labs/routekit ${version}\n`);
    });
  const parseAsync = program.parseAsync.bind(program);
  program.parseAsync = (argv, options) =>
    runWithCliSession(session, async () => await parseAsync(argv, options));
  return Object.assign(program, { commandTelemetry, runtime, session });
}
