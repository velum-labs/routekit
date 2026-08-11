import { attachGlobalFlags, registerCompletion } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import { registerDynamicCompletion } from "../completion.js";
import { assertLocalTarget, setTargetSelectionFromCommand } from "../target.js";
import { registerAccounts } from "./accounts.js";
import { registerCalls } from "./calls.js";
import { registerConfig } from "./config.js";
import { configOverride } from "./context.js";
import { registerCredentials } from "./credentials.js";
import { registerDaemon } from "./daemon.js";
import { registerDoctor } from "./doctor.js";
import { registerLaunchers } from "./launchers.js";
import { registerLeaderboard } from "./leaderboard.js";
import { registerModels } from "./models.js";
import { registerPeer } from "./peer.js";
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

const EXPLICIT_CONFIG_COMMANDS = new Set(["doctor"]);
const CONFIG_INDEPENDENT_COMMANDS = new Set([
  "version",
  "completion",
  "__complete",
  "__self-inspect",
  "token shell",
  "credential get",
  "daemon run",
  "self-update"
]);
const LOCAL_ONLY_COMMANDS = new Set(["start", "stop", "setup", "config init"]);

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current.parent !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

export function registerCommands(program: Command): void {
  attachGlobalFlags(program);
  program.option("--config <path>", "router config path for doctor only");
  program.option("--remote <name>", "target a named remote gateway");
  program.option("--local", "force the local RouteKit daemon");
  program.hook("preAction", (_root, actionCommand) => {
    setTargetSelectionFromCommand(actionCommand);
    const override = configOverride(actionCommand) ?? process.env.ROUTEKIT_CONFIG;
    const path = commandPath(actionCommand);
    if (LOCAL_ONLY_COMMANDS.has(path) || path.startsWith("daemon ")) {
      assertLocalTarget(path);
    }
    if (
      override !== undefined &&
      override.length > 0 &&
      !EXPLICIT_CONFIG_COMMANDS.has(path) &&
      !CONFIG_INDEPENDENT_COMMANDS.has(path)
    ) {
      throw new Error(
        "--config / ROUTEKIT_CONFIG are not supported by singleton daemon operations; " +
          "use `routekit config import --from <path>`"
      );
    }
  });
  program.commandsGroup("Setup");
  registerSetup(program);
  registerRemote(program);
  registerPeer(program);
  registerTokens(program);
  registerCredentials(program);
  registerAccounts(program);
  registerProviders(program);
  registerConfig(program);

  program.commandsGroup("Run");
  registerStart(program);
  registerStop(program);
  registerDaemon(program);
  registerLaunchers(program);

  program.commandsGroup("Inspect");
  registerStatus(program);
  registerUsage(program);
  registerLeaderboard(program);
  registerCalls(program);
  registerModels(program);
  registerDoctor(program);

  program.commandsGroup("Maintain");
  registerSelfUpdate(program);
  registerSelfInspect(program);
  registerTelemetry(program);
  registerCompletion(program, "routekit");
  registerDynamicCompletion(program);
}
