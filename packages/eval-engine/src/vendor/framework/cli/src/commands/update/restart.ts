import { Effect } from "effect";

import type { UpdateRestartMode } from "./ori-config.ts";

import { isCompiledCliBuild } from "../../build-info.ts";
import { devDependencyRestartArgvFrom } from "../dev/dependencies.ts";
import { DaemonShutdown } from "../../daemon-shutdown.ts";

/** Exit code for a clean, intentional daemon stop (supervisor restart). */
const CLEAN_EXIT_CODE = 0;

/** Outcome of draining in-flight runs before a restart. */
export interface RestartDrainResult {
  readonly drained: boolean;
}

/**
 * The process-level actions a restart performs, isolated behind an interface so
 * the restart flow can be unit-tested without spawning processes or exiting.
 */
export interface RestartLauncher {
  /** Exit cleanly for a supervisor (systemd/docker `restart: always`) to relaunch us. */
  readonly cleanExit: () => Effect.Effect<void>;
  /** Spawn the freshly-installed binary (inheriting stdio) and exit this process. */
  readonly relaunch: (input: {
    readonly args: readonly string[];
    readonly command: string;
  }) => Effect.Effect<void>;
}

/** Build the argv that re-invokes the running `ori` with the same subcommand and flags. */
export const resolveRestartArgv = (): readonly string[] =>
  devDependencyRestartArgvFrom({
    execPath: process.execPath,
    main: process.argv[1],
    processArgv: process.argv,
  });

/**
 * Production launcher: rather than terminating the process from this (forked,
 * fire-and-forget auto-update) fiber, it *requests* shutdown from the
 * daemon-owned {@link DaemonShutdown} coordinator. The daemon's main fiber
 * awaits that request, unwinds the session scope so every finalizer runs (HTTP
 * server stop, runtime dispose, schedule/chat teardown), and only then exits or
 * re-execs. This keeps the raw exit syscall out of background fibers entirely
 * and is what makes shutdown graceful.
 *
 * For `relaunch`, the daemon spawns the replacement *after* finalizers release
 * the loopback port, preserving the original port-handoff guarantee: the
 * replacement process can bind the port the old one just freed.
 */
export const makeDefaultLauncher = Effect.fn("Restart.makeDefaultLauncher")(
  function* () {
    const shutdown = yield* DaemonShutdown;
    return {
      cleanExit: (): Effect.Effect<void> =>
        shutdown.requestExit(CLEAN_EXIT_CODE),
      relaunch: (input: {
        readonly args: readonly string[];
        readonly command: string;
      }): Effect.Effect<void> =>
        shutdown.requestRelaunch({
          args: input.args,
          command: input.command,
        }),
    } satisfies RestartLauncher;
  }
);

export interface RunUpdateRestartOptions {
  /** Best-effort drain of in-flight agent runs; should already encode the drain timeout. */
  readonly drain: Effect.Effect<RestartDrainResult>;
  /**
   * The process-level launcher. Required so `runUpdateRestart` stays free of any
   * `DaemonShutdown` requirement in its type — production callers pass
   * {@link makeDefaultLauncher}'s result (resolved in the daemon scope), tests
   * pass a recording fake.
   */
  readonly launcher: RestartLauncher;
  readonly log: (line: string) => Effect.Effect<void>;
  readonly mode: UpdateRestartMode;
}

/**
 * Restart `ori start` after an update: drain in-flight runs (bounded by the
 * configured drain timeout), then either re-exec the new binary (`reexec`, the
 * default) or exit cleanly for a process supervisor (`exit`). In production this
 * never returns — the process is replaced or exits.
 */
export const runUpdateRestart = Effect.fn("Restart.runUpdateRestart")(
  function* (options: RunUpdateRestartOptions) {
    yield* options.log(
      "[ori-update] Draining in-flight runs before restart..."
    );
    const result = yield* options.drain;
    yield* options.log(
      result.drained
        ? "[ori-update] In-flight runs drained; restarting."
        : "[ori-update] Drain timed out; restarting with runs still active."
    );

    const { launcher } = options;
    if (options.mode === "exit") {
      yield* options.log("[ori-update] Exiting for supervisor restart.");
      return yield* launcher.cleanExit();
    }

    const restartArgv = resolveRestartArgv();
    yield* Effect.logDebug("ori update/start restart", {
      execPath: process.execPath,
      isCompiledCliBuild: isCompiledCliBuild(),
      main: process.argv[1],
      restartArgv,
    });
    if (restartArgv.length === 0) {
      yield* options.log(
        "[ori-update] No executable to re-exec; exiting for supervisor restart."
      );
      return yield* launcher.cleanExit();
    }
    const [command, ...args] = restartArgv;
    yield* options.log("[ori-update] Re-executing the updated Ori binary.");
    return yield* launcher.relaunch({
      args,
      command,
    });
  }
);
