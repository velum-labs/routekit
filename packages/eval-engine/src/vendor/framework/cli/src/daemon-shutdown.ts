import { spawn } from "node:child_process";

import { Context, Data, Deferred, Effect, Layer } from "effect";

import { OriCliExit } from "./cli-exit.ts";

/** Exit code for a clean re-exec handoff (the replacement process carries on). */
const RELAUNCH_EXIT_CODE = 0;

/**
 * A request to shut the daemon down, resolved through {@link DaemonShutdown}.
 *
 * The daemon's main fiber blocks on {@link DaemonShutdownShape.await} in place
 * of `Effect.never`; resolving the underlying `Deferred` unwinds the enclosing
 * `Effect.scoped`, so every acquired resource (the HTTP server, the daemon
 * `ManagedRuntime`, schedule/chat contributions) runs its finalizer *before*
 * the program returns. The daemon then acts on the request rather than any
 * fiber invoking a manual exit syscall directly:
 *
 * - `Exit` — return the carried exit code to the runtime teardown (see
 *   `cli-exit.ts`'s `OriCliExit`). Used for supervisor-restart (`mode: "exit"`)
 *   and signal-driven shutdown.
 * - `Relaunch` — re-exec the (freshly updated/installed) binary. The spawn
 *   happens only after the session scope's finalizers have released the
 *   loopback port, so the replacement process can bind it.
 */
export type DaemonShutdownRequest = Data.TaggedEnum<{
  Exit: { readonly code: number };
  Relaunch: { readonly args: readonly string[]; readonly command: string };
}>;

/** Constructors + `$match`/`$is` for {@link DaemonShutdownRequest}. */
export const DaemonShutdownRequest = Data.taggedEnum<DaemonShutdownRequest>();

export interface DaemonShutdownShape {
  /**
   * Block until a shutdown is requested. The daemon main fiber awaits this in
   * place of `Effect.never`; it is interruptible, so a `runMain` signal
   * (SIGINT/SIGTERM → interruption) still tears the session scope down cleanly.
   */
  readonly await: Effect.Effect<DaemonShutdownRequest>;
  /** Request a clean process exit with `code` after finalizers run. First request wins. */
  readonly requestExit: (code: number) => Effect.Effect<void>;
  /**
   * Request a re-exec of `command`/`args` after finalizers run (freeing the
   * loopback port for the replacement). First request wins.
   */
  readonly requestRelaunch: (input: {
    readonly args: readonly string[];
    readonly command: string;
  }) => Effect.Effect<void>;
}

/**
 * Daemon-owned shutdown coordinator. A single `Deferred` is the source of
 * truth: launchers, the auto-update fiber, and signal handlers all *request*
 * shutdown by resolving it; the daemon main fiber awaits it and performs the
 * actual graceful teardown + exit. No fiber invokes a manual exit syscall itself.
 */
export class DaemonShutdown extends Context.Service<
  DaemonShutdown,
  DaemonShutdownShape
>()("ori/cli/DaemonShutdown") {
  static readonly layer = Layer.effect(DaemonShutdown)(
    Effect.gen(function* () {
      const signal = yield* Deferred.make<DaemonShutdownRequest>();
      return DaemonShutdown.of({
        await: Deferred.await(signal),
        requestExit: (code) =>
          Deferred.succeed(signal, DaemonShutdownRequest.Exit({ code })).pipe(
            Effect.asVoid
          ),
        requestRelaunch: (input) =>
          Deferred.succeed(
            signal,
            DaemonShutdownRequest.Relaunch({
              args: input.args,
              command: input.command,
            })
          ).pipe(Effect.asVoid),
      });
    })
  );
}

/**
 * Act on a resolved {@link DaemonShutdownRequest} *after* the daemon session
 * scope has unwound (so every finalizer has run and, for a relaunch, the
 * loopback port is free). Never invokes a manual exit syscall: both paths fail
 * with the {@link OriCliExit} marker so the `runMain` teardown applies the exit
 * code after Effect's own finalizers.
 *
 * `Relaunch` spawns the replacement first — `node:child_process` spawn inherits
 * the parent environment by default, so the child sees the same env (including
 * any ORI_* overrides); the child is orphaned, not killed, by the subsequent
 * exit.
 */
export const performDaemonShutdown = (
  request: DaemonShutdownRequest
): Effect.Effect<never, OriCliExit> =>
  DaemonShutdownRequest.$match(request, {
    Exit: ({ code }) => new OriCliExit({ exitCode: code }),
    // Spawn inside `Effect.sync` so it runs within the Effect runtime: the
    // side effect fires only when this Effect is executed (not at construction
    // time), and a spawn failure surfaces as a runtime defect the teardown can
    // observe rather than escaping the error channel at call time.
    Relaunch: ({ args, command }) =>
      Effect.sync(() => {
        spawn(command, [...args], {
          stdio: "inherit",
        });
      }).pipe(Effect.andThen(new OriCliExit({ exitCode: RELAUNCH_EXIT_CODE }))),
  });
