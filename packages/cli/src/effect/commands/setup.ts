import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { SetupRouteKit } from "../../services/setup/service.js";
import { routekitRoot } from "../root-command.js";

export const makeSetupCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const setupRouteKit = new SetupRouteKit();
  return Command.make(
    "setup",
    {
      browserless: Flag.boolean("no-browser").pipe(
        Flag.withDescription("prefer browserless subscription login flows")
      )
    },
    ({ browserless }) =>
      Effect.gen(function* () {
        yield* setupRouteKit.execute({
          browser: !browserless,
          context: contextForFlags(yield* routekitRoot, runtime),
          runtime
        });
      })
  ).pipe(Command.withDescription("interactively configure and verify first-launch routes"));
};
