import { ChildProcess } from "effect/unstable/process";

// Effect's Node/Bun spawner defaults `detached` to `true` on non-Windows
// platforms, which calls `setsid()` and gives the child its own session +
// process group. The kernel delivers SIGWINCH only to the controlling
// terminal's *foreground* process group, so a detached child never receives
// terminal-resize signals — an interactive TUI spawned that way freezes its
// layout at launch size until a manual redraw. Pinning `detached: false` keeps
// the child in the foreground group so it reflows live.
//
// Use this only for genuinely interactive children. Non-interactive one-shot
// tools (build/lint/pack/eval) do not need SIGWINCH and should spawn directly.

const FOREGROUND_STDIO = {
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
} as const;

export interface InteractiveChildOptions {
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

/**
 * Make a `ChildProcess` command for an interactive foreground child, pinned to
 * the terminal's foreground process group (`detached: false`) with inherited
 * stdio so it receives SIGWINCH and can reflow on terminal resize.
 */
export const makeInteractiveChildCommand = (
  command: string,
  args: readonly string[],
  options: InteractiveChildOptions = {}
): ChildProcess.StandardCommand =>
  ChildProcess.make(command, args, {
    cwd: options.cwd,
    detached: false,
    env: options.env,
    ...FOREGROUND_STDIO,
  });
