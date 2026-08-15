/**
 * The production Ori eval product with the unrelated product surface removed.
 *
 * This is deliberately a composition root, not a reimplementation. Every
 * command below is the production command used by the full `ori` binary, and
 * the daemon/harness runtime is the production runtime.
 */
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Cause, Effect, Layer } from "effect";

import type { DaemonRuntime } from "./vendor/framework/runloop/local/src/daemon/server/server-types.ts";
import type { DevCommandRuntimeOptions } from "./vendor/framework/cli/src/commands/dev/session-support.ts";

import { fetchHttpClientLayer } from "./vendor/framework/contracts/internal/src/http-client.ts";
import { makeOriDaemonRuntime } from "./vendor/framework/runloop/local/src/daemon/core/layers.ts";
import { OriCliExit } from "./vendor/framework/cli/src/cli-exit.ts";
import { authCommand } from "./vendor/framework/cli/src/commands/auth/command.ts";
import { makeCodeCommand } from "./vendor/framework/cli/src/commands/code/command.ts";
import { makeEvalCommand } from "./vendor/framework/cli/src/commands/eval/command.ts";
import { loginCommand } from "./vendor/framework/cli/src/commands/login/command.ts";
import { DaemonShutdown } from "./vendor/framework/cli/src/daemon-shutdown.ts";
import {
  bootstrapReportingLayer,
  reportOriCliFailure,
  runOriCli,
} from "./vendor/framework/cli/src/ori.ts";

import { evalSystemSkillCommand } from "./eval-skill-command";
import { parseProductArgv } from "./product-argv";
import { providedEvalCliLayer } from "./product-catalog";
import {
  type EvalDaemonDependenciesOptions,
  makeEvalDaemonDependenciesLayer,
  makeProvidedEvalDaemonLayer,
} from "./product-runtime";
import { applyHostProviderEnv } from "./host-env";
import { evalSystemSpawnCommand } from "./spawn-command";
import { runSpawnWorkflow } from "./spawn-workflow";
import { evalSystemVersionCommand } from "./version-command";

const SUCCESS_EXIT_CODE = 0;

const makeProductDaemonRuntime = (options: EvalDaemonDependenciesOptions = {}): DaemonRuntime => {
  const dependencies = makeEvalDaemonDependenciesLayer(options);
  return makeOriDaemonRuntime<typeof dependencies>({
    daemonLayer: makeProvidedEvalDaemonLayer(dependencies, options),
    dependencies,
  });
};

const makeEvalSystemCommands = (options: DevCommandRuntimeOptions) =>
  [
    loginCommand,
    authCommand,
    makeCodeCommand(options),
    makeEvalCommand(options, evalSystemSkillCommand),
    evalSystemSpawnCommand,
    evalSystemVersionCommand,
  ] as const;

/**
 * Run the focused product.
 *
 * Requires Node 22.22+ on PATH. Eval files run through `node --test`.
 * Spawn keeps its own JSON protocol, so it is dispatched before Effect CLI
 * after stripping leading output-mode flags. Version is a real roster command
 * so `-v` / `--version` resolve.
 */
export const runEvalSystem = async (): Promise<void> => {
  applyHostProviderEnv();

  const argv = parseProductArgv();
  if (argv.command === "spawn") {
    await runSpawnWorkflow(argv.commandArgs.slice(1));
    return;
  }

  runMain(
    runOriCli({
      makeDaemonRuntime: makeProductDaemonRuntime,
      makeSubcommands: makeEvalSystemCommands,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(DaemonShutdown.layer, providedEvalCliLayer, fetchHttpClientLayer),
      ),
      Effect.catchCause((cause) =>
        reportOriCliFailure(Cause.squash(cause), {
          makeDaemonRuntime: makeProductDaemonRuntime,
          makeSubcommands: makeEvalSystemCommands,
        }).pipe(Effect.provide(bootstrapReportingLayer)),
      ),
      Effect.andThen((exitCode) =>
        exitCode === SUCCESS_EXIT_CODE ? Effect.void : new OriCliExit({ exitCode }),
      ),
    ),
    { disableErrorReporting: true },
  );
};

export { makeEvalSystemCommands, makeProductDaemonRuntime };
