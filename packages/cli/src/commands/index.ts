import {
  attachGlobalFlags,
  type CliRuntime,
  COMPLETION_SHELLS,
  completionScript,
  isCompletionShell,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";
import type { CliSession } from "../cli-session.js";
import { commandPath } from "../command-path.js";
import { registerDynamicCompletion } from "../completion.js";
import { assertLocalTarget, setTargetSelectionFromCommand } from "../target.js";
import { registerAccounts } from "./accounts.js";
import { registerCalls } from "./calls.js";
import { registerConfig } from "./config.js";
import { registerCredentials } from "./credentials.js";
import { registerDaemon } from "./daemon.js";
import { registerDoctor } from "./doctor.js";
import { registerEval } from "./eval.js";
import { registerLaunchers } from "./launchers.js";
import { registerLeaderboard } from "./leaderboard.js";
import { registerModels } from "./models.js";
import { registerPeer } from "./peer.js";
import { registerPolicy } from "./policy.js";
import { registerProviders } from "./providers.js";
import { registerRemote } from "./remote.js";
import { registerSelfInspect } from "./self-inspect.js";
import { registerSelfUpdate } from "./self-update.js";
import { registerSetup } from "./setup.js";
import { registerStart } from "./start.js";
import { registerStatus } from "./status.js";
import { registerStop } from "./stop.js";
import { registerTelemetry } from "./telemetry.js";
import { registerTokens } from "./tokens.js";
import { registerUsage } from "./usage.js";

const LOCAL_ONLY_COMMANDS = new Set([
  "start",
  "stop",
  "setup",
  "config init",
  "eval discover",
  "eval list",
  "eval dry-run",
  "eval run",
  "eval show"
]);

export function registerCommands(
  program: Command,
  session: CliSession,
  runtime: CliRuntime = processCliRuntime
): void {
  attachGlobalFlags(program);
  program.option("--remote <name>", "target a named remote gateway");
  program.option("--local", "force the local RouteKit daemon");
  program.hook("preAction", (_root, actionCommand) => {
    setTargetSelectionFromCommand(actionCommand, session);
    const path = commandPath(actionCommand);
    if (LOCAL_ONLY_COMMANDS.has(path) || path.startsWith("daemon ")) {
      assertLocalTarget(path);
    }
  });
  program.commandsGroup("Setup");
  registerSetup(program, runtime);
  registerRemote(program, session, runtime);
  registerPeer(program, runtime);
  registerTokens(program, runtime);
  registerCredentials(program, runtime);
  registerAccounts(program, runtime);
  registerProviders(program, runtime);
  registerConfig(program, runtime);

  program.commandsGroup("Run");
  registerStart(program, runtime);
  registerStop(program, runtime);
  registerDaemon(program, runtime);
  registerLaunchers(program, runtime);

  program.commandsGroup("Inspect");
  registerStatus(program, runtime);
  registerUsage(program, runtime);
  registerLeaderboard(program, runtime);
  registerCalls(program, runtime);
  registerModels(program, runtime);
  registerDoctor(program, runtime);

  program.commandsGroup("Evaluate");
  registerEval(program, runtime);
  registerPolicy(program, runtime);

  program.commandsGroup("Maintain");
  registerSelfUpdate(program, runtime);
  registerSelfInspect(program, runtime);
  registerTelemetry(program, runtime);
  program
    .command("completion")
    .description("advanced: print a shell completion script")
    .argument("<shell>", COMPLETION_SHELLS.join(" | "))
    .action((shell: string) => {
      if (!isCompletionShell(shell)) {
        throw new Error(`unsupported shell "${shell}" (expected ${COMPLETION_SHELLS.join(" | ")})`);
      }
      runtime.stdout.write(completionScript(shell, "routekit", program));
    });
  registerDynamicCompletion(program, runtime);
}
