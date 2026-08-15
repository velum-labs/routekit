import { Effect, Option } from "effect";

import type { GatewayAuthSource } from "../../../../contracts/internal/src/gateway-auth.ts";
import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { DaemonRuntime } from "../../../../runloop/local/src/daemon/server/server-types.ts";
import type { RunLabel } from "../../../../runloop/local/src/dev/log-store.ts";
import type { DevLogRetentionOverrides } from "./event-log-file.ts";
import type { ResolvedAutoUpdateConfig } from "./session-contributions.ts";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  DEFAULT_DAEMON_HOST,
  EPHEMERAL_DAEMON_PORT,
} from "../../../../runloop/local/src/daemon/core/http-defaults.ts";
import { runDaemonServer } from "../../../../runloop/local/src/daemon/server/server.ts";
import { workspaceRootFromFeaturesRoot } from "../../../../runloop/local/src/dev/descriptor.ts";
import {
  startChatContributions,
  startScheduleContributions,
} from "./contribution-runners.ts";
import { startDevEventLogFile } from "./event-log-file.ts";
import { publishDevDescriptor } from "./publish-descriptor.ts";
import { startDaemonContributions } from "./session-contributions.ts";
import {
  currentWorkingDirectory,
  FEATURES_DIR,
  prepareDevFeaturesRoot,
  resolveDevFeaturesRoot,
  resolveGlobalWorkspaceContext,
  shouldAnnounceGlobalFallback,
} from "./session-features-root.ts";
import {
  DaemonShutdown,
  performDaemonShutdown,
} from "../../daemon-shutdown.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const shouldRunSplitDevSession = (isStdoutTty: boolean): boolean => isStdoutTty;

type DevCommandAuthSource = Option.Option<GatewayAuthSource>;

interface DevCommandRuntimeOptions {
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
  readonly makeDaemonRuntime: (options?: {
    readonly authSource?: DevCommandAuthSource;
    readonly devLogWorkspaceRoot?: string | undefined;
    readonly externalSkillsRoot?: string | undefined;
    readonly featuresRoot?: string | undefined;
    readonly suppressAuditStdout?: boolean | undefined;
    readonly suppressTuiLogs?: boolean | undefined;
  }) => DaemonRuntime;
}

interface StartedDevDaemon {
  readonly host: string;
  readonly port: number;
  readonly runtime: DaemonRuntime;
}

const startDevDaemon = Effect.fn("DevCommand.startDaemon")(function* (
  options: DevCommandRuntimeOptions,
  config: {
    readonly authSource: DevCommandAuthSource;
    /** Expose dev-only routes (e.g. schedule dispatch); off for `routekit-eval start`. */
    readonly enableDevRoutes?: boolean;
    /** Root containing this daemon's persisted dev logs. */
    readonly devLogWorkspaceRoot?: string | undefined;
    /** Launch cwd used for `routekit-eval code` external skill discovery. */
    readonly externalSkillsRoot?: string | undefined;
    readonly featuresRoot: string | undefined;
    readonly host: string;
    readonly port: Option.Option<number>;
    /** Keep the audit log off stdout while a TUI owns the terminal. */
    readonly suppressAuditStdout?: boolean;
    /** Keep built-in daemon diagnostics off the terminal while `routekit-eval code` owns it. */
    readonly suppressTuiLogs?: boolean;
    /**
     * Keep the daemon's `[routekit-eval-runtime] listening …` boot line off stdout. Only
     * `routekit-eval code` sets this because its standalone chat normally renders inline,
     * where a boot line on stdout would be painted over. The split dev session
     * owns an alternate screen and intentionally leaves it set false.
     */
    readonly suppressBootLine?: boolean;
  }
) {
  const bindPort = Option.getOrElse(config.port, () => EPHEMERAL_DAEMON_PORT);
  const daemonRuntime = options.makeDaemonRuntime({
    authSource: config.authSource,
    devLogWorkspaceRoot: config.devLogWorkspaceRoot,
    externalSkillsRoot: config.externalSkillsRoot,
    featuresRoot: config.featuresRoot,
    suppressAuditStdout: config.suppressAuditStdout,
    suppressTuiLogs: config.suppressTuiLogs,
  });
  const server = yield* runDaemonServer({
    enableDevRoutes: config.enableDevRoutes ?? false,
    featuresRoot: config.featuresRoot,
    host: config.host,
    makeRuntime: () => daemonRuntime,
    port: bindPort,
    suppressBootLine: config.suppressBootLine,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CliFailureError({
          detail: `Could not start the dev runtime at http://${config.host}:${bindPort}: ${formatUnknownError(cause)}`,
        })
    )
  );
  return {
    host: server.hostname,
    port: server.port,
    runtime: daemonRuntime,
  } satisfies StartedDevDaemon;
});

interface HeadlessRuntimeSessionConfig {
  readonly authSource: DevCommandAuthSource;
  /** Launch cwd used for `routekit-eval code` external skill discovery. */
  readonly externalSkillsRoot?: string | undefined;
  readonly features: Option.Option<string>;
  readonly host: string;
  readonly install: boolean;
  readonly port: Option.Option<number>;
  readonly watchReloads: boolean;
  /**
   * Arm registered `schedule` contributions so their cron timers fire for the
   * session. `routekit-eval start` always sets this; `routekit-eval dev` leaves it off by default
   * (RFC 0002 schedule.md — opt in with `--enable-schedules`). Either way the dev process
   * still exposes the manual `POST /api/dev/schedules/:name` dispatch route.
   */
  readonly armSchedules: boolean;
  /**
   * Start registered headless `chat` contributions (e.g. a Slack/HTTP bridge) so
   * the intern is reachable on its chat surface(s). `routekit-eval start` sets this (live
   * deployment without a second `routekit-eval tui`); `routekit-eval dev` leaves it off and attaches
   * the terminal TUI instead. The terminal TUI built-in (`@routekit-eval-builtins/chat-tui`)
   * is always skipped here — it cannot run headless; attach it with `routekit-eval tui`.
   */
  readonly startChats: boolean;
  /**
   * Expose the dev-only `POST /api/dev/schedules/:name` manual dispatch route on
   * the daemon. Per RFC 0008, `routekit-eval dev` sets this `true` (so a developer can fire
   * a schedule on demand) and `routekit-eval start` leaves it off. It is independent of
   * {@link armSchedules}: `routekit-eval dev` exposes the manual route whether or not it
   * auto-fires; `routekit-eval start` auto-fires but does NOT expose the route.
   */
  readonly enableDevRoutes: boolean;
  /**
   * Verb shown in the boot banner and the event-log run-file label — "dev"
   * for `routekit-eval dev`, "start" for `routekit-eval start`, "code" for `routekit-eval code`.
   */
  readonly runtimeLabel: RunLabel;
  readonly eventLog?:
    | { readonly retention: DevLogRetentionOverrides }
    | undefined;
  /**
   * Resolved auto-update policy. When present and not `off`, `routekit-eval start` runs a
   * periodic update checker inside the session scope so it is torn down on
   * shutdown. `routekit-eval dev` leaves this unset — only the long-lived `routekit-eval start`
   * server self-updates.
   */
  readonly autoUpdate?: ResolvedAutoUpdateConfig | undefined;
  /** `routekit-eval code` override for the descriptor + event log location; see {@link publishDevDescriptor}. */
  readonly descriptorWorkspaceRoot?: string;
  /**
   * Overrides the workspace root that anchors author-contracts and
   * `ROUTEKIT_EVAL_INTERN_WORKSPACE_ROOT` in {@link prepareDevFeaturesRoot}. `routekit-eval start`
   * sets this when it consolidates several `--features` sources into a composed
   * root under `.routekit-eval/composed`, so the anchor stays on the real project rather
   * than the cache dir. Absent → `dirname(featuresRoot)` as before.
   */
  readonly workspaceRoot?: string;
}

const formatHeadlessRuntimeMessage = (
  config: {
    readonly host: string;
    readonly label: string;
    readonly port: number;
    readonly watchReloads: boolean;
  },
  featuresRoot: string
): string => {
  const watchLine = config.watchReloads
    ? `Watching ${featuresRoot} for changes. `
    : "";
  return (
    `RouteKitEval ${config.label} runtime listening at http://${config.host}:${config.port}\n` +
    `${watchLine}Attach the chat with \`routekit-eval tui\` or stream events with \`routekit-eval logs --live\`. Press Ctrl+C to stop.\n`
  );
};

const startReloadWatcherIfEnabled = Effect.fn("DevCommand.startReloadWatcher")(
  function* (input: {
    readonly config: HeadlessRuntimeSessionConfig;
    readonly daemon: StartedDevDaemon;
    readonly featuresRoot: string;
  }) {
    if (!input.config.watchReloads) {
      return;
    }
    // Imported lazily: the reload watcher pulls in a heavy agent-runner subtree
    // the headless `routekit-eval start` path (watchReloads=false) never touches; a top-level
    // import would drag it into every session-support importer's coverage graph.
    const { startDevReloadWatcher } = yield* Effect.promise(
      () => import("./reload-watcher.ts")
    );
    yield* startDevReloadWatcher(input.featuresRoot, input.daemon.runtime);
  }
);

const writeHeadlessBanner = Effect.fn("DevCommand.writeHeadlessBanner")(
  function* (input: {
    readonly config: HeadlessRuntimeSessionConfig;
    readonly daemon: StartedDevDaemon;
    readonly featuresRoot: string;
  }) {
    const cliIo = yield* CliIo;
    yield* cliIo.writeStdout(
      formatHeadlessRuntimeMessage(
        {
          host: input.daemon.host,
          label: input.config.runtimeLabel,
          port: input.daemon.port,
          watchReloads: input.config.watchReloads,
        },
        input.featuresRoot
      )
    );
  }
);

const runDaemonSessionScope = Effect.fn("DevCommand.daemonSessionScope")(
  function* (
    options: DevCommandRuntimeOptions,
    config: HeadlessRuntimeSessionConfig,
    prepared: { readonly featuresRoot: string; readonly workspaceRoot: string }
  ) {
    const shutdown = yield* DaemonShutdown;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* startDevDaemon(options, {
          authSource: config.authSource,
          enableDevRoutes: config.enableDevRoutes,
          externalSkillsRoot: config.externalSkillsRoot,
          featuresRoot: prepared.featuresRoot,
          host: config.host,
          port: config.port,
        });
        yield* startReloadWatcherIfEnabled({
          config,
          daemon,
          featuresRoot: prepared.featuresRoot,
        });
        // Anchor precedence: an explicit caller override (`routekit-eval code`'s launch
        // cwd) > the resolved workspace (honours the `routekit-eval.md`-composition anchor
        // so a composed `.routekit-eval/composed` root still writes the descriptor into the
        // declaring project) > `dirname(featuresRoot)` inside publishDevDescriptor.
        const workspaceRoot = yield* publishDevDescriptor(
          prepared.featuresRoot,
          daemon,
          {
            descriptorWorkspaceRoot:
              config.descriptorWorkspaceRoot ?? prepared.workspaceRoot,
          }
        );
        yield* writeHeadlessBanner({
          config,
          daemon,
          featuresRoot: prepared.featuresRoot,
        });
        yield* startDaemonContributions({
          armSchedules: config.armSchedules,
          autoUpdate: config.autoUpdate,
          daemon,
          eventLog: config.eventLog,
          featuresRoot: prepared.featuresRoot,
          runLabel: config.runtimeLabel,
          startChats: config.startChats,
          telemetryObserver: options.telemetryObserver,
          workspaceRoot,
        });
        return yield* shutdown.await;
      })
    );
  }
);

/**
 * Boot the daemon in this process, publish the dev descriptor so `routekit-eval tui` and
 * `routekit-eval logs` can attach from another terminal, optionally watch for reloads,
 * print a banner, and block until Ctrl+C. There is no TUI and no events pane:
 * this is the bare bot server. Shared by `routekit-eval start` (always) and `routekit-eval dev`'s
 * non-interactive fallback.
 */
export const runHeadlessRuntimeSession = Effect.fn(
  "DevCommand.headlessSession"
)(function* (
  options: DevCommandRuntimeOptions,
  config: HeadlessRuntimeSessionConfig
) {
  const prepared = yield* prepareDevFeaturesRoot(config);
  const request = yield* runDaemonSessionScope(options, config, prepared);
  // `performDaemonShutdown` owns the re-exec/exit via the `RouteKitEvalCliExit` teardown
  // marker, not a syscall.
  return yield* performDaemonShutdown(request);
});

export {
  FEATURES_DIR,
  shouldRunSplitDevSession,
  shouldAnnounceGlobalFallback,
  startDevDaemon,
  currentWorkingDirectory,
  resolveDevFeaturesRoot,
  resolveGlobalWorkspaceContext,
  prepareDevFeaturesRoot,
  formatHeadlessRuntimeMessage,
};
export type {
  DevCommandAuthSource,
  DevCommandRuntimeOptions,
  StartedDevDaemon,
  HeadlessRuntimeSessionConfig,
};
export { DEFAULT_DAEMON_HOST };
// Re-exported so `dev/command.ts` reaches these through this shared support module
// (already a `dev-descriptor`/`event-log-file` dependency) instead of taking direct
// dependencies, keeping the command within the architecture fan-out budget.
export { workspaceRootFromFeaturesRoot };
export { startDevEventLogFile };
export type { DevLogRetentionOverrides };
// The schedule/chat contribution runners live in their own module to keep this
// support file under the architecture budget; re-exported for a single import surface.
export { startChatContributions, startScheduleContributions };
