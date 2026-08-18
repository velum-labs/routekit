import type { Option } from "effect";

import { Clock, Effect, Layer, Result } from "effect";
import { Stdio } from "effect/Stdio";
import { Command } from "effect/unstable/cli";

import type { OpenRouterAuthSource } from "../../contracts/internal/src/openrouter-auth.ts";
import type { TelemetryObserverShape } from "../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { TelemetryUsageSinkShape } from "../../contracts/internal/src/runtime/telemetry-usage-sink.ts";
import type { DaemonRuntime } from "../../runloop/local/src/daemon/server/server-types.ts";
import type { CommandNameNode } from "./command-path.ts";
import type { DevCommandRuntimeOptions } from "./commands/dev/session-support.ts";

import { CliIo } from "../../contracts/internal/src/cli/cli-io.ts";
import { fetchHttpClientLayer } from "../../contracts/internal/src/http-client.ts";
import { TelemetryObserver } from "../../contracts/internal/src/runtime/telemetry-observer.ts";
import {
  nodeServicesLayer,
  cliIoLayer,
  hostRuntimeLayer,
} from "../../runloop/local/src/runtime/io-layer.ts";
import { PassthroughArgs } from "./argv-passthrough.ts";
import {
  emitCommandTelemetry,
  runCliProgramWithTelemetry,
} from "./cli-telemetry.ts";
import {
  classifyCliExit,
  telemetryFailure,
} from "./cli-telemetry-decisions.ts";
import {
  describeCommandLabel,
  resolveFailureCommandLabel,
  ROOT_COMMAND_LABEL,
} from "./command-label.ts";
import { buildCommandNameTree } from "./command-path.ts";
import { splitAgentLaunchArgv } from "./commands/agent-launch.ts";
import {
  captureAmbientOpenRouterKey,
  loadStoredOpenRouterKeyIntoEnv,
} from "./commands/login/credentials.ts";
import { emitCachedUpdateBanner } from "./commands/update/cached-update-banner.ts";
import { readVersionInfo } from "./commands/version/version-info.ts";
import { applyDefaultCommand } from "./default-command.ts";
import { OriDirectoryLive } from "./ori-directory-live.ts";
import {
  bootstrapReportingLayer,
  reportOriCliBootstrapFailure,
  resolveBootstrapOutputMode,
  stripLeadingOutputGlobalFlags,
} from "./ori-report.ts";
import {
  makeOutputModeLayer,
  outputGlobalFlags,
} from "./output-global-flags.ts";
import { Telemetry } from "./telemetry/telemetry.ts";
import { telemetryCommandPath } from "./telemetry/telemetry-command-path.ts";
import {
  makeTelemetryUsageSink,
  telemetryUsageSinkLayer,
} from "./telemetry/telemetry-log-sink.ts";
import {
  daemonTelemetryObserverLayer,
  telemetryObserverLayer,
} from "./telemetry/telemetry-observer.ts";

const SUCCESS_EXIT_CODE = 0;

// Fallback when the CLI package.json cannot be read; the real value is sourced
// at runtime from `framework/cli/package.json` (see commands/version).
const FALLBACK_VERSION = "0.0.0";
interface OriCliRuntimeOptions {
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
  readonly makeDaemonRuntime: (options?: {
    readonly authSource?: Option.Option<OpenRouterAuthSource>;
    readonly externalSkillsRoot?: string | undefined;
    readonly featuresRoot?: string | undefined;
    readonly suppressAuditStdout?: boolean | undefined;
    readonly telemetryObserverLayer?: Layer.Layer<TelemetryObserver>;
    readonly telemetryUsageSink?: TelemetryUsageSinkShape | undefined;
  }) => DaemonRuntime;
}

type AnyOriSubcommand = Command.Command<any, any, any, any, any>;

interface RunOriCliOptions<
  Subcommands extends readonly AnyOriSubcommand[] =
    readonly AnyOriSubcommand[],
> extends OriCliRuntimeOptions {
  readonly args?: readonly string[];
  /**
   * Product-specific command roster.
   *
   * The full Ori binary supplies its complete roster. Focused products such as
   * the standalone eval system supply a narrower roster while retaining this
   * exact production bootstrap, reporting, authentication, telemetry, and
   * daemon runtime.
   */
  readonly makeSubcommands: (
    options: DevCommandRuntimeOptions
  ) => Subcommands;
}

const makeOriCommand = <
  Subcommands extends readonly AnyOriSubcommand[],
>(
  options: OriCliRuntimeOptions & {
    readonly subcommands: Subcommands;
  }
) =>
  Command.make("ori").pipe(
    Command.withDescription(
      "Standalone Ori eval system. Login, author a headless eval interview with spawn, and run *.eval.ts files against a real model."
    ),
    Command.withSubcommands(options.subcommands)
  );

// Resolve the banner's output mode and command from the CLI-owned argv only:
// `cliArgv` excludes the passthrough tail, and stripping the leading global
// output flags lets the banner's command gate see the real command (so a
// leading `--human`/`--tty` cannot bypass BANNER_EXCLUDED_COMMANDS).
const emitRunUpdateBanner = Effect.fn("OriCli.emitRunUpdateBanner")(function* (
  cliArgv: readonly string[],
  routedArgs: readonly string[]
) {
  const cliIo = yield* CliIo;
  const isStdoutTty = yield* cliIo.isStdoutTty;
  const outputMode = yield* resolveBootstrapOutputMode(cliArgv);
  yield* emitCachedUpdateBanner(
    stripLeadingOutputGlobalFlags(routedArgs),
    outputMode,
    isStdoutTty
  ).pipe(Effect.ignore);
});

// The observer is bound because schedule_run reaches the CLI fiber through
// DevCommandRuntimeOptions.telemetryObserver. Daemon-side events like agent_run
// read Telemetry from the daemon's own context.
export const bindDaemonRuntimeOptions = Effect.fn(
  "OriCli.bindDaemonRuntimeOptions"
)(function* (makeDaemonRuntime: OriCliRuntimeOptions["makeDaemonRuntime"]) {
  const telemetryObserver = yield* TelemetryObserver;
  const telemetry = yield* Telemetry;
  const bound: OriCliRuntimeOptions = {
    makeDaemonRuntime: (daemonOptions) =>
      makeDaemonRuntime({
        ...daemonOptions,
        telemetryObserverLayer: daemonTelemetryObserverLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              nodeServicesLayer,
              cliIoLayer,
              hostRuntimeLayer,
              fetchHttpClientLayer
            )
          )
        ),
        telemetryUsageSink: makeTelemetryUsageSink(telemetry),
      }),
    telemetryObserver,
  };
  return bound;
});

// Turns a run failure into an exit code, reporting only failures that no
// handler already surfaced. The tree-resolved `command` label keeps positional
// prompt words out of the JSON error envelope (RFC 0004).
const reportRunFailure = Effect.fn("OriCli.reportRunFailure")(function* (
  failure: unknown,
  routedArgs: readonly string[],
  commandTree: ReadonlyMap<string, CommandNameNode>
) {
  const decision = classifyCliExit(failure);
  if (decision._tag !== "report") {
    return decision._tag === "exit" ? decision.code : SUCCESS_EXIT_CODE;
  }
  return yield* reportOriCliBootstrapFailure(
    failure,
    routedArgs,
    describeCommandLabel(routedArgs, commandTree)
  );
});

const resolveFailureCommand = (
  argv: readonly string[],
  options: RunOriCliOptions<readonly AnyOriSubcommand[]>
): Effect.Effect<string> =>
  Effect.try(() =>
    resolveFailureCommandLabel(argv, options.makeSubcommands(options))
  ).pipe(Effect.orElseSucceed(() => ROOT_COMMAND_LABEL));

const reportOriCliFailure = Effect.fn("OriCli.reportFailure")(function* (
  error: unknown,
  options: RunOriCliOptions<readonly AnyOriSubcommand[]>
) {
  const stdio = yield* Stdio;
  const argv = yield* stdio.args;
  return yield* reportOriCliBootstrapFailure(
    error,
    argv,
    yield* resolveFailureCommand(argv, options)
  );
});

const runOriCliInner = Effect.fn("OriCli.runInner")(function* <
  Subcommands extends readonly AnyOriSubcommand[],
>({
  args,
  makeSubcommands,
  makeDaemonRuntime,
}: RunOriCliOptions<Subcommands>) {
  // Record whether OPENROUTER_API_KEY was genuinely inherited BEFORE we
  // pre-load any stored (including global) credential into the env — the
  // workspace-scoped `ori dev`/`ori start` gate relies on this snapshot to
  // tell a real ambient key apart from a bootstrap-loaded global one.
  yield* captureAmbientOpenRouterKey();
  yield* loadStoredOpenRouterKeyIntoEnv();
  const stdio = yield* Stdio;
  const commandArgs = args ?? (yield* stdio.args);
  const { cliArgv, passthrough } = splitAgentLaunchArgv(commandArgs);
  const runtimeOptions = yield* bindDaemonRuntimeOptions(makeDaemonRuntime);
  const subcommands = makeSubcommands(runtimeOptions);
  const commandTree = buildCommandNameTree(subcommands);
  const routedArgs = applyDefaultCommand(cliArgv, new Set(commandTree.keys()));
  const version = yield* readVersionInfo.pipe(
    Effect.map((info) => info.version),
    Effect.orElseSucceed(() => FALLBACK_VERSION)
  );
  const telemetry = yield* Telemetry;
  const startedAt = yield* Clock.currentTimeMillis;
  // withGlobalFlags comes after provide so its context exclusion erases the
  // settings the OutputMode layer consumes; the runner supplies them at parse
  // time around every handler.
  const baseCommand = makeOriCommand({
    ...runtimeOptions,
    subcommands,
  });
  const command = baseCommand.pipe(
    Command.provide(makeOutputModeLayer()),
    Command.withGlobalFlags(outputGlobalFlags)
  );
  const program = Command.runWith(command, { version })(routedArgs);
  const commandPath = telemetryCommandPath(
    baseCommand,
    routedArgs,
    Result.fail(null)
  );
  const result = yield* runCliProgramWithTelemetry({
    command: commandPath,
    program: program.pipe(Effect.provideService(PassthroughArgs, passthrough)),
    startedAt,
    telemetry,
  });
  const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
  const failure = telemetryFailure(result);
  yield* emitCommandTelemetry({
    command: telemetryCommandPath(baseCommand, routedArgs, result),
    durationMs,
    failure,
    telemetry,
  });

  if (Result.isFailure(result)) {
    return yield* reportRunFailure(result.failure, routedArgs, commandTree);
  }

  yield* emitRunUpdateBanner(cliArgv, routedArgs);
  return SUCCESS_EXIT_CODE;
});

export const runOriCli = Effect.fn("OriCli.run")(function* <
  Subcommands extends readonly AnyOriSubcommand[],
>(options: RunOriCliOptions<Subcommands>) {
  return yield* runOriCliInner(options).pipe(
    Effect.provide(
      // The observer layer exposes its live Telemetry via `provideMerge`,
      // so the CLI's direct `Telemetry.emit` and the observer's forwarded
      // events share one buffering client and one session identity.
      Layer.mergeAll(
        telemetryUsageSinkLayer.pipe(
          Layer.provideMerge(telemetryObserverLayer)
        ),
        OriDirectoryLive
      )
    )
  );
});

export {
  bootstrapReportingLayer,
  makeOriCommand,
  reportOriCliBootstrapFailure,
  reportOriCliFailure,
};
export type { OriCliRuntimeOptions, RunOriCliOptions };
