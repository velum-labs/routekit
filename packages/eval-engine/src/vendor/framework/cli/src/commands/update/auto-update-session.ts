import { Effect } from "effect";

import type { TelemetryObserverShape } from "../../../../contracts/internal/src/runtime/telemetry-observer.ts";
import type { DaemonRuntime } from "../../../../runloop/local/src/daemon/server/server-types.ts";
import type { ResolvedAutoUpdateConfig } from "./ori-config.ts";
import type { RestartDrainResult } from "./restart.ts";

import { CliIo, stdoutLineLogger } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { ReloadCoordinator } from "../../../../runloop/local/src/reload/coordinator.ts";
import {
  makeProductionAutoUpdateActions,
  runAutoUpdateLoop,
} from "./auto-update.ts";
import { makeLogNotifier } from "./notify/notifier.ts";
import {
  makeDefaultLauncher,
  runUpdateRestart,
} from "./restart.ts";
import { readCurrentExecutablePath } from "./update-runner.ts";

/**
 * The auto-update drain timeout is in ms; `0` from a `--drain-timeout 0` flag
 * means "wait unbounded" for in-flight runs. The `ReloadCoordinator` drain takes
 * a finite millisecond timeout, so map `0` to the largest safe integer.
 */
const UNBOUNDED_DRAIN_MS = Number.MAX_SAFE_INTEGER;
const MS_PER_MINUTE = 60_000;

/**
 * Start the auto-update poll loop inside the session scope. The restart drains
 * in-flight runs through the daemon's {@link ReloadCoordinator} (bounded by the
 * configured drain timeout) before re-execing or exiting. The fiber shares the
 * session scope, so it tears down cleanly on shutdown. Held updates (above the
 * auto-apply threshold) are surfaced to the log with an `ori update` instruction.
 */
export const startAutoUpdate = Effect.fn("DevCommand.autoUpdate")(
  function* (input: {
    readonly config: ResolvedAutoUpdateConfig;
    readonly runtime: DaemonRuntime;
    readonly workspaceRoot: string;
    readonly telemetryObserver?: TelemetryObserverShape | undefined;
  }) {
    const cliIo = yield* CliIo;
    const log = stdoutLineLogger(cliIo);
    const executablePath = readCurrentExecutablePath();
    const drainTimeoutMs =
      input.config.drainTimeoutMs === 0
        ? UNBOUNDED_DRAIN_MS
        : input.config.drainTimeoutMs;
    // `Effect.tryPromise` keeps a rejected `runPromise` (e.g. a disposed runtime)
    // an expected error rather than a defect; `orElseSucceed` then degrades it to
    // "not drained" so the restart still proceeds instead of silently killing the
    // auto-update fiber.
    const drain: Effect.Effect<RestartDrainResult> = Effect.tryPromise(() =>
      input.runtime.runPromise(
        Effect.gen(function* () {
          const coordinator = yield* ReloadCoordinator;
          const result = yield* coordinator.drain({
            timeoutMs: drainTimeoutMs,
          });
          return { drained: result.drained } satisfies RestartDrainResult;
        })
      )
    ).pipe(
      Effect.orElseSucceed(
        () => ({ drained: false }) satisfies RestartDrainResult
      )
    );
    const restart = runUpdateRestart({
      drain,
      launcher: yield* makeDefaultLauncher(),
      log,
      mode: input.config.restart,
    });
    const actions = makeProductionAutoUpdateActions({
      channel: input.config.channel,
      executablePath,
      restart,
    });
    const notifier = makeLogNotifier(log);

    yield* runAutoUpdateLoop({
      actions,
      config: input.config,
      log,
      notifier,
      telemetryObserver: input.telemetryObserver,
      workspaceRoot: input.workspaceRoot,
    }).pipe(Effect.forkScoped);
  }
);

export const formatAutoUpdateBanner = (
  config: ResolvedAutoUpdateConfig
): string => {
  const intervalMinutes = Math.round(config.intervalMs / MS_PER_MINUTE);
  const channelSuffix =
    config.channel === "alpha" ? " on the alpha channel" : "";
  return (
    `Auto-update: applying ${config.level} updates and below every ${intervalMinutes}m${channelSuffix} ` +
    `(restart=${config.restart}).\n`
  );
};

// Re-exported so the dev session runner hub types its `autoUpdate` config field
// through this module (its single update-domain dependency) rather than reaching
// directly into the update config module.
export type { ResolvedAutoUpdateConfig };
