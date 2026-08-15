import type { Option } from "effect";

import { Clock, Effect, Layer, Result } from "effect";
import { Stdio } from "effect/Stdio";
import { Command } from "effect/unstable/cli";

import type { GatewayAuthSource } from "../../contracts/internal/src/gateway-auth.ts";
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
  captureAmbientGatewayKey,
  loadStoredGatewayKeyIntoEnv,
} from "./commands/login/credentials.ts";
import { emitCachedUpdateBanner } from "./commands/update/cached-update-banner.ts";
import { readVersionInfo } from "./commands/version/version-info.ts";
import { applyDefaultCommand } from "./default-command.ts";
import { RouteKitEvalDirectoryLive } from "./routekit-eval-directory-live.ts";
import {
  bootstrapReportingLayer,
  reportRouteKitEvalCliBootstrapFailure,
  resolveBootstrapOutputMode,
  stripLeadingOutputGlobalFlags,
} from "./routekit-eval-report.ts";
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
interface RouteKitEvalCliRuntimeOptions {
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
  readonly makeDaemonRuntime: (options?: {
    readonly authSource?: Option.Option<GatewayAuthSource>;
    readonly externalSkillsRoot?: string | undefined;
    readonly featuresRoot?: string | undefined;
    readonly suppressAuditStdout?: boolean | undefined;
    readonly telemetryObserverLayer?: Layer.Layer<TelemetryObserver>;
    readonly telemetryUsageSink?: TelemetryUsageSinkShape | undefined;
  }) => DaemonRuntime;
}

type AnyRouteKitEvalSubcommand = Command.Command<any, any, any, any, any>;

interface RunRouteKitEvalCliOptions<
  Subcommands extends readonly AnyRouteKitEvalSubcommand[] =
    readonly AnyRouteKitEvalSubcommand[],
> extends RouteKitEvalCliRuntimeOptions {
  readonly args?: readonly string[];
  /**
   * Product-specific command roster.
   *
   * The full RouteKitEval binary supplies its complete roster. Focused products such as
   * the standalone eval system supply a narrower roster while retaining this
   * exact production bootstrap, reporting, authentication, telemetry, and
   * daemon runtime.
   */
  readonly makeSubcommands: (
    options: DevCommandRuntimeOptions
  ) => Subcommands;
}

const makeRouteKitEvalCommand = <
  Subcommands extends readonly AnyRouteKitEvalSubcommand[],
>(
  options: RouteKitEvalCliRuntimeOptions & {
    readonly subcommands: Subcommands;
  }
) =>
  Command.make("routekit-eval").pipe(
    Command.withDescription(
      "Standalone RouteKitEval eval system. Login, author a headless eval interview with spawn, and run *.eval.ts files against a real model."
    ),
    Command.withSubcommands(options.subcommands)
  );

// Resolve the banner's output mode and command from the CLI-owned argv only:
// `cliArgv` excludes the passthrough tail, and stripping the leading global
// output flags lets the banner's command gate see the real command (so a
// leading `--human`/`--tty` cannot bypass BANNER_EXCLUDED_COMMANDS).
const emitRunUpdateBanner = Effect.fn("RouteKitEvalCli.emitRunUpdateBanner")(function* (
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
  "RouteKitEvalCli.bindDaemonRuntimeOptions"
)(function* (makeDaemonRuntime: RouteKitEvalCliRuntimeOptions["makeDaemonRuntime"]) {
  const telemetryObserver = yield* TelemetryObserver;
  const telemetry = yield* Telemetry;
  const bound: RouteKitEvalCliRuntimeOptions = {
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
const reportRunFailure = Effect.fn("RouteKitEvalCli.reportRunFailure")(function* (
  failure: unknown,
  routedArgs: readonly string[],
  commandTree: ReadonlyMap<string, CommandNameNode>
) {
  const decision = classifyCliExit(failure);
  if (decision._tag !== "report") {
    return decision._tag === "exit" ? decision.code : SUCCESS_EXIT_CODE;
  }
  return yield* reportRouteKitEvalCliBootstrapFailure(
    failure,
    routedArgs,
    describeCommandLabel(routedArgs, commandTree)
  );
});

const resolveFailureCommand = (
  argv: readonly string[],
  options: RunRouteKitEvalCliOptions<readonly AnyRouteKitEvalSubcommand[]>
): Effect.Effect<string> =>
  Effect.try(() =>
    resolveFailureCommandLabel(argv, options.makeSubcommands(options))
  ).pipe(Effect.orElseSucceed(() => ROOT_COMMAND_LABEL));

const reportRouteKitEvalCliFailure = Effect.fn("RouteKitEvalCli.reportFailure")(function* (
  error: unknown,
  options: RunRouteKitEvalCliOptions<readonly AnyRouteKitEvalSubcommand[]>
) {
  const stdio = yield* Stdio;
  const argv = yield* stdio.args;
  return yield* reportRouteKitEvalCliBootstrapFailure(
    error,
    argv,
    yield* resolveFailureCommand(argv, options)
  );
});

const runRouteKitEvalCliInner = Effect.fn("RouteKitEvalCli.runInner")(function* <
  Subcommands extends readonly AnyRouteKitEvalSubcommand[],
>({
  args,
  makeSubcommands,
  makeDaemonRuntime,
}: RunRouteKitEvalCliOptions<Subcommands>) {
  // Record whether ROUTEKIT_EVAL_BEARER_TOKEN was genuinely inherited BEFORE we
  // pre-load any stored (including global) credential into the env — the
  // workspace-scoped `routekit-eval dev`/`routekit-eval start` gate relies on this snapshot to
  // tell a real ambient key apart from a bootstrap-loaded global one.
  yield* captureAmbientGatewayKey();
  yield* loadStoredGatewayKeyIntoEnv();
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
  const baseCommand = makeRouteKitEvalCommand({
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

export const runRouteKitEvalCli = Effect.fn("RouteKitEvalCli.run")(function* <
  Subcommands extends readonly AnyRouteKitEvalSubcommand[],
>(options: RunRouteKitEvalCliOptions<Subcommands>) {
  return yield* runRouteKitEvalCliInner(options).pipe(
    Effect.provide(
      // The observer layer exposes its live Telemetry via `provideMerge`,
      // so the CLI's direct `Telemetry.emit` and the observer's forwarded
      // events share one buffering client and one session identity.
      Layer.mergeAll(
        telemetryUsageSinkLayer.pipe(
          Layer.provideMerge(telemetryObserverLayer)
        ),
        RouteKitEvalDirectoryLive
      )
    )
  );
});

export {
  bootstrapReportingLayer,
  makeRouteKitEvalCommand,
  reportRouteKitEvalCliBootstrapFailure,
  reportRouteKitEvalCliFailure,
};
export type { RouteKitEvalCliRuntimeOptions, RunRouteKitEvalCliOptions };
