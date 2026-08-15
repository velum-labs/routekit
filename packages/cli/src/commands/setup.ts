import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { type Command, Option } from "commander";

import { runCliEffect } from "../cli-session.js";
import { SetupRouteKit } from "../use-cases/setup.js";

export {
  credentialDescription,
  preferredModelOptions,
  preflightSetupApiProvider,
  SETUP_API_PROVIDER_IDS,
  setupCandidateConfig
} from "../use-cases/setup.js";

export function registerSetup(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const setupRouteKit = new SetupRouteKit();
  program
    .command("setup")
    .description("interactively configure and verify first-launch routes")
    .addOption(new Option("--no-browser", "prefer browserless subscription login flows"))
    .action(async (options: { browser?: boolean }, command: Command) => {
      await runCliEffect(
        setupRouteKit.execute({
          ...(options.browser !== undefined ? { browser: options.browser } : {}),
          context: contextFor(command, runtime),
          runtime
        })
      );
    });
}
