// How `routekit-eval eval` gets a runtime for the child to talk to: the ephemeral daemon
// and its boot config.
//
// Split out of `command.ts` so that file stays about the command's own shape
// (flags, discovery, the import guard, the two run paths). Nothing here is
// reached by `--dry-run` or `--list`: neither invokes an agent, so neither needs
// a runtime to invoke it against.
import type { PlatformError, Terminal } from "effect";
import type { Stdio } from "effect/Stdio";
import type { Prompt } from "effect/unstable/cli";
import type { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { Effect, FileSystem, Option, Path } from "effect";

import type { CliIoError } from "../../../../contracts/internal/src/errors.ts";
import type { RouteKitEvalCliExit } from "../../cli-exit.ts";
import type { DevCommandRuntimeOptions } from "../dev/session-support.ts";
import type { EvalRuntimeProvider } from "./node-test-run.ts";
import type { EvalCommandConfig } from "./command.ts";
import type { RouteKitEvalDirectory } from "../../routekit-eval-directory.ts";
import type { Telemetry } from "../../telemetry/telemetry.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  prepareDevFeaturesRoot,
  startDevDaemon,
} from "../dev/session-support.ts";

const RUNTIME_HOST_ENV = "ROUTEKIT_EVAL_RUNTIME_HOST";
const RUNTIME_PORT_ENV = "ROUTEKIT_EVAL_RUNTIME_PORT";

// The error/service union the production (daemon-booting) provider introduces:
// prepareDevFeaturesRoot + startDevDaemon + the daemon's `logDaemonServer` (Stdio).
// `RouteKitEvalCliExit` comes from prepareDevFeaturesRoot: an `install: true` boot may
// install workspace deps and re-exec, propagating the child's exit code as a
// deliberate `RouteKitEvalCliExit` rather than a manual exit syscall.
type ProductionEvalErrors =
  | CliFailureError
  | CliIoError
  | RouteKitEvalCliExit
  | PlatformError.PlatformError
  | Terminal.QuitError;
type ProductionEvalServices =
  | CliIo
  | FileSystem.FileSystem
  | HostProcess
  | HttpClient.HttpClient
  | RouteKitEvalDirectory
  | Path.Path
  | Prompt.Environment
  | Stdio
  | Telemetry;

export const resolveEvalFeatures = Effect.fn("EvalCommand.resolveFeatures")(
  function* (config: EvalCommandConfig, workingDirectory: string) {
    if (Option.isSome(config.features)) {
      return config.features;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fs
      .stat(path.join(workingDirectory, "features"))
      .pipe(Effect.option);
    return info.pipe(
      Option.filter((value) => value.type === "Directory"),
      Option.map(() => path.join(workingDirectory, "features"))
    );
  }
);

/**
 * The daemon boot config `routekit-eval eval` uses. Exported so a test can assert the
 * stdout-suppression flags without booting a real daemon: both of them exist
 * purely to keep the JSON envelope alone on stdout, and a regression is silent
 * (the command still works, but an agent's `JSON.parse` starts failing).
 */
export const evalDaemonBootConfig = (
  config: EvalCommandConfig,
  featuresRoot: string | undefined
): Parameters<typeof startDevDaemon>[1] => ({
  // The command's credential gate has already loaded the resolved key into the
  // process environment this daemon reads its secret from. The source is only
  // ever used for the audit line, which `suppressAuditStdout` drops anyway.
  authSource: Option.none(),
  enableDevRoutes: false,
  featuresRoot,
  host: config.host,
  // No `--port`: bind an ephemeral open port so concurrent `routekit-eval eval` runs never
  // collide on the default daemon port.
  port: Option.none(),
  suppressAuditStdout: true,
  // The `[routekit-eval-runtime] listening …` boot line would otherwise land on stdout
  // ahead of the JSON envelope and break the `JSON.parse` an agent runs over
  // piped stdout. Nothing reads the address off stdout: the child is handed it
  // through ROUTEKIT_EVAL_RUNTIME_HOST/PORT. It is noise for a human too, since the port is
  // ephemeral and dies with the command.
  suppressBootLine: true,
});

const makeDaemonRuntimeProvider = (
  options: DevCommandRuntimeOptions,
  config: EvalCommandConfig
): EvalRuntimeProvider<ProductionEvalErrors, ProductionEvalServices> => ({
  withRuntime: (
    baseEnv,
    runTests,
    workingDirectory
  ): Effect.Effect<
    number,
    ProductionEvalErrors,
    ProductionEvalServices | ChildProcessSpawner.ChildProcessSpawner | Stdio
  > =>
    Effect.scoped(
      Effect.gen(function* () {
        const { featuresRoot } = yield* prepareDevFeaturesRoot({
          features: yield* resolveEvalFeatures(config, workingDirectory),
          install: true,
        });
        const daemon = yield* startDevDaemon(
          options,
          evalDaemonBootConfig(config, featuresRoot)
        );
        const env = {
          ...baseEnv,
          [RUNTIME_HOST_ENV]: daemon.host,
          [RUNTIME_PORT_ENV]: String(daemon.port),
        };
        return yield* runTests(env);
      })
    ),
});

export { makeDaemonRuntimeProvider };
export type { ProductionEvalErrors, ProductionEvalServices };
