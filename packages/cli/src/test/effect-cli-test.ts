import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { CliConfig, Command, GlobalFlag } from "effect/unstable/cli";
import type * as CommandType from "effect/unstable/cli/Command";

import type { RouteKitProgram } from "../cli.js";
import { runWithCliSession } from "../cli-session.js";
import { routekitVersion } from "../state.js";

export async function runProgram(
  program: RouteKitProgram,
  args: readonly string[]
): Promise<void> {
  try {
    await runWithCliSession(program.session, () =>
      runRouteKitEffect(
        Command.runWith(program, { version: routekitVersion(), renderErrors: false })(args).pipe(
          Effect.provideService(
            CliConfig.CliConfig,
            CliConfig.make({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel] })
          )
        ),
        program.session.effectRuntime
      )
    );
  } finally {
    await program.session.dispose();
  }
}

export function child(
  command: CommandType.Command.Any,
  name: string
): CommandType.Command.Any {
  const found = command.subcommands.flatMap((group) => group.commands).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing command ${name}`);
  return found;
}
