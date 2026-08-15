import { Context, Effect, Layer } from "effect";

import type {
  CliFailureError,
  CliIoError,
} from "../errors.ts";

import type { OutputMode } from "./output-mode.ts";

import { interactiveCommandError } from "./cli-output.ts";
import { currentOutputMode } from "./output-mode.ts";

interface CliIoShape {
  readonly isStdinTty: Effect.Effect<boolean>;
  readonly isStdoutTty: Effect.Effect<boolean>;
  readonly readStdin: Effect.Effect<string, CliIoError>;
  readonly writeStderr: (text: string) => Effect.Effect<void, CliIoError>;
  readonly writeStdout: (text: string) => Effect.Effect<void, CliIoError>;
}

/**
 * Guard for interactive commands (`routekit-eval tui`, the split `routekit-eval dev` session): in
 * machine/JSON output mode (piped or `--json`) they can't render a full-screen
 * UI, so fail with an actionable {@link interactiveCommandError}; otherwise
 * succeed so the caller proceeds to launch its terminal app.
 */
const ensureInteractiveOutput = (
  command: string
): Effect.Effect<void, CliFailureError, OutputMode> =>
  currentOutputMode().pipe(
    Effect.flatMap((mode) =>
      mode === "json" ? interactiveCommandError(command) : Effect.void
    )
  );

/**
 * The CLI stdio boundary: TTY detection, reading piped stdin, and writing to
 * stdout (results) or stderr (diagnostics). This is a pure port — the effectful
 * implementation that reads the real process stdio lives in the
 * `@routekit-eval-engine/runtime-io` adapter (`cli-io.ts`) as `CliIoLive`, and
 * {@link CliIo.layerTest} provides a deterministic stand-in for tests.
 */
export class CliIo extends Context.Service<CliIo, CliIoShape>()(
  "routekit-eval/runtime/CliIo"
) {
  /**
   * Test seam: a `CliIo` with inert deterministic defaults. Unset fields report
   * a non-TTY stdin/stdout, empty stdin, and no-op writes. Override only the
   * fields a case cares about.
   */
  static readonly layerTest = (impl: Partial<CliIoShape>): Layer.Layer<CliIo> =>
    Layer.succeed(CliIo)(
      CliIo.of({
        isStdinTty: Effect.succeed(false),
        isStdoutTty: Effect.succeed(false),
        readStdin: Effect.succeed(""),
        writeStderr: () => Effect.void,
        writeStdout: () => Effect.void,
        ...impl,
      })
    );
}

/**
 * Best-effort line logger over {@link CliIo.writeStdout}: appends the newline
 * and swallows write failures, matching how progress lines are reported by
 * long-running commands (a broken pipe must not fail the underlying work).
 */
const stdoutLineLogger =
  (cliIo: CliIo["Service"]): ((line: string) => Effect.Effect<void>) =>
  (line) =>
    cliIo.writeStdout(`${line}\n`).pipe(Effect.ignore);

const stderrLineLogger =
  (cliIo: CliIo["Service"]): ((line: string) => Effect.Effect<void>) =>
  (line) =>
    cliIo.writeStderr(`${line}\n`).pipe(Effect.ignore);

export { ensureInteractiveOutput, stderrLineLogger, stdoutLineLogger };
export type { CliIoShape };
