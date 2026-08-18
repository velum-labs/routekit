import { mkdir } from "node:fs/promises";

import { Effect, Layer } from "effect";

import type { CreateEvalToolInput, CreateEvalToolResult } from "./public-api.ts";

import { fetchHttpClientLayer } from "./vendor/framework/contracts/internal/src/http-client.ts";
import { makeEvalCommand } from "./vendor/framework/cli/src/commands/eval/command.ts";
import { DaemonShutdown } from "./vendor/framework/cli/src/daemon-shutdown.ts";
import { runOriCli } from "./vendor/framework/cli/src/ori.ts";
import { nodeServicesLayer } from "./vendor/framework/runloop/local/src/runtime/io-layer.ts";
import { evalSystemSkillCommand } from "./eval-skill-command.ts";
import {
  applyHostProviderEnv,
  withHostProviderEnvironment,
} from "./host-env.ts";
import { makeProvidedEvalCliLayer } from "./product-catalog.ts";
import { makeProductDaemonRuntime } from "./main.ts";
import { makeIsolatedRuntimeIo } from "./runtime/isolated-runtime.ts";

/**
 * Run the real production eval command behind plain data ports.
 *
 * This is also the target of the dedicated eval-tool worker installed for an
 * author harness's shell. It invokes command code in-process; it never launches
 * the Ori executable.
 */
const runEvalTool = async (
  input: CreateEvalToolInput,
): Promise<CreateEvalToolResult> => {
  const environment: NodeJS.ProcessEnv = { ...input.environment };
  applyHostProviderEnv(environment);
  await mkdir(input.homeDirectory, { recursive: true, mode: 0o700 });
  const { runtimeIo, stderr, stdout } = makeIsolatedRuntimeIo({
    cwd: input.cwd,
    environment,
    homeDirectory: input.homeDirectory,
  });
  // The `ori` shim execs this worker with the author's argv (`ori eval …`).
  // Library callers pass flags only. Prepending `eval` twice makes the extra
  // `eval` the positional target, so `ori eval evals/support` dies as
  // "Unexpected positional argument".
  const args = input.args[0] === "eval" ? input.args : ["eval", ...input.args];
  const program = runOriCli({
    args,
    makeDaemonRuntime: (options) =>
      makeProductDaemonRuntime({
        ...options,
        runtimeIo,
      }),
    makeSubcommands: (options) => [
      makeEvalCommand(options, evalSystemSkillCommand),
    ],
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DaemonShutdown.layer,
        makeProvidedEvalCliLayer(runtimeIo),
        fetchHttpClientLayer,
      ),
    ),
    Effect.provide(nodeServicesLayer),
  );
  const exitCode = await withHostProviderEnvironment(environment, () =>
    Effect.runPromise(program),
  );
  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
};

export { runEvalTool };
