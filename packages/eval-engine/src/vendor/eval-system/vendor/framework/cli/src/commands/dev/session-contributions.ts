import { Effect } from "effect";

import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { DaemonRuntime } from "../../../../runloop/local/src/daemon/server/server-types.ts";
import type { RunLabel } from "../../../../runloop/local/src/dev/log-store.ts";
import type { DevLogRetentionOverrides } from "./event-log-file.ts";
import type { ResolvedAutoUpdateConfig } from "../update/auto-update-session.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { readPackedInternLaunchCwd } from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { loopbackHost } from "../../../../runloop/local/src/daemon/server/server.ts";
import {
  startChatContributions,
  startScheduleContributions,
} from "./contribution-runners.ts";
import { installSessionFeatureResolvers } from "./contribution-runners-state.ts";
import { startDevEventLogFile } from "./event-log-file.ts";
import { writeProgressNotice } from "./progress-notice.ts";
import {
  formatAutoUpdateBanner,
  startAutoUpdate,
} from "../update/auto-update-session.ts";
/**
 * Arm the periodic auto-update checker for the running server, the third
 * session-scoped background runner (alongside schedules and chats) that
 * `runHeadlessRuntimeSession` starts inside its scope. A no-op unless an
 * `autoUpdate` policy is present and not `off`: only the long-lived `routekit-eval start`
 * server self-updates. Prints the active-policy banner, then delegates to
 * {@link startAutoUpdate}, which forks the poll loop into the caller's scope so
 * it tears down on shutdown.
 */
const startAutoUpdateSession = Effect.fn("DevCommand.autoUpdate")(
  function* (input: {
    readonly autoUpdate: ResolvedAutoUpdateConfig | undefined;
    readonly runtime: Parameters<typeof startAutoUpdate>[0]["runtime"];
    readonly telemetryObserver?: TelemetryObserverShape | undefined;
    readonly workspaceRoot: string;
  }) {
    if (input.autoUpdate === undefined || input.autoUpdate.level === "off") {
      return;
    }
    yield* writeProgressNotice(formatAutoUpdateBanner(input.autoUpdate));
    yield* startAutoUpdate({
      config: input.autoUpdate,
      runtime: input.runtime,
      telemetryObserver: input.telemetryObserver,
      workspaceRoot: input.workspaceRoot,
    });
  }
);

const startAutoUpdateForDaemon = (input: {
  readonly autoUpdate: ResolvedAutoUpdateConfig | undefined;
  readonly runtime: DaemonRuntime;
  readonly telemetryObserver: TelemetryObserverShape | undefined;
  readonly workspaceRoot: string;
}): ReturnType<typeof startAutoUpdateSession> =>
  startAutoUpdateSession({
    autoUpdate: input.autoUpdate,
    runtime: input.runtime,
    telemetryObserver: input.telemetryObserver,
    workspaceRoot: input.workspaceRoot,
  });

/** The running daemon's connection facts, as the contribution runners need them. */
interface DaemonContributionTarget {
  readonly host: string;
  readonly port: number;
  readonly runtime: DaemonRuntime;
}

const startEventLogIfEnabled = Effect.fn("DevCommand.eventLog")(
  function* (input: {
    readonly daemon: DaemonContributionTarget;
    readonly eventLog:
      | { readonly retention: DevLogRetentionOverrides }
      | undefined;
    readonly runLabel: RunLabel;
    readonly workspaceRoot: string;
  }) {
    if (input.eventLog === undefined) {
      return;
    }
    const eventLog = yield* startDevEventLogFile({
      retention: input.eventLog.retention,
      runLabel: input.runLabel,
      runtime: input.daemon.runtime,
      workspaceRoot: input.workspaceRoot,
    });
    yield* writeProgressNotice(`Writing event log to ${eventLog.path}\n`);
  }
);

/**
 * Start every session-scoped background contribution for a booted daemon — the
 * event-log file, schedule timers, chat surfaces, and the auto-update poller —
 * inside the caller's scope, so all of them tear down when the session scope
 * closes. Extracted from `runHeadlessRuntimeSession` to keep that file within
 * the architecture line budget; this module already owns each `start*` runner.
 */
interface StartDaemonContributionsInput {
  readonly armSchedules: boolean;
  readonly autoUpdate: ResolvedAutoUpdateConfig | undefined;
  readonly daemon: DaemonContributionTarget;
  readonly eventLog:
    | { readonly retention: DevLogRetentionOverrides }
    | undefined;
  readonly featuresRoot: string;
  /** Run-file label for the event log (`dev` for `routekit-eval dev`, `start` for `routekit-eval start`). */
  readonly runLabel: RunLabel;
  readonly startChats: boolean;
  readonly telemetryObserver?: TelemetryObserverShape | undefined;
  readonly workspaceRoot: string;
}

export const startDaemonContributions = Effect.fn(
  "DevCommand.daemonContributions"
)(function* (input: StartDaemonContributionsInput) {
  const { daemon, featuresRoot, workspaceRoot } = input;
  yield* startEventLogIfEnabled({
    daemon,
    eventLog: input.eventLog,
    runLabel: input.runLabel,
    workspaceRoot,
  });

  // Install the process-global state + config resolvers before any surface starts,
  // so `routekit-eval/state`/`Chat.stores` and `routekit-eval/config`/`Chat.config` resolve in-process
  // (RFC 0005). Skipped when no contribution runs, so a bare session never boots.
  const runsFeatureCode = input.armSchedules || input.startChats;
  const { configResolver, storeResolver } =
    yield* installSessionFeatureResolvers({
      featuresRoot,
      runsFeatureCode,
      workspaceRoot,
    });
  const launcherCwd = readPackedInternLaunchCwd(
    yield* (yield* HostProcess).env
  );

  if (input.armSchedules) {
    yield* startScheduleContributions({
      // Scheduler diagnostics flow to the daemon log hub `routekit-eval logs` reads (RFC
      // 0011); `loopbackHost` maps a wildcard bind (0.0.0.0/::) for the API dial.
      cwd: launcherCwd ?? workspaceRoot,
      daemonRuntime: daemon.runtime,
      featuresRoot,
      host: loopbackHost(daemon.host),
      port: daemon.port,
      telemetryObserver: input.telemetryObserver,
    });
  }

  if (input.startChats) {
    yield* startChatContributions({
      // Chat surfaces dial the daemon's own HTTP API exactly like schedules;
      // map a wildcard bind address (0.0.0.0/::) to a connectable loopback.
      config: configResolver,
      cwd: launcherCwd ?? workspaceRoot,
      featuresRoot,
      stores: storeResolver,
      host: loopbackHost(daemon.host),
      port: daemon.port,
      runLabel: input.runLabel,
    });
  }

  yield* startAutoUpdateForDaemon({
    autoUpdate: input.autoUpdate,
    runtime: daemon.runtime,
    telemetryObserver: input.telemetryObserver,
    workspaceRoot,
  });
});

export { startAutoUpdateSession };
export type { DaemonContributionTarget };
// Re-exported so `session-support` types its `autoUpdate` config field through
// this runner hub (its single dependency for session-scoped runners) instead of
// taking a direct dependency on the update config module.
export type { ResolvedAutoUpdateConfig };
