import { Effect, Layer, Stream } from "effect";
import { Stdio } from "effect/Stdio";

import { CliIo } from "../../../contracts/internal/src/cli/cli-io.ts";
import { CliIoError, isBrokenPipeCause } from "../../../contracts/internal/src/errors.ts";

/**
 * The live {@link CliIo} adapter: the single sanctioned CLI stdio boundary. The
 * stdin byte stream and the stdout/stderr sinks flow through the platform
 * {@link Stdio} service (kept in the requirement channel, so root wiring supplies
 * it via `bunServicesLayer` and tests can swap `Stdio.layerTest`). The TTY flags
 * are read from the raw process handles instead, because `Stdio` does not expose
 * `isTTY`; a missing handle (`undefined`) reads as "not a TTY". Diagnostics route
 * to stderr and results to stdout so the two never collide (RFC 0011) — the
 * caller picks the stream via `writeStderr`/`writeStdout`.
 */
const toCliIoError =
  (operation: string) =>
  (cause: unknown): CliIoError =>
    new CliIoError({
      cause,
      operation,
    });

const readStdinText = Effect.fn("CliIo.readStdin")(function* (stdio: Stdio) {
  return yield* stdio.stdin.pipe(
    Stream.mapError(toCliIoError("reading stdin")),
    Stream.decodeText(),
    Stream.mkString
  );
});

const writeSink = Effect.fn("CliIo.writeSink")(function* (
  sink: ReturnType<Stdio["stdout"]>,
  operation: string,
  text: string
) {
  yield* Stream.succeed(text).pipe(
    Stream.run(sink),
    Effect.mapError(toCliIoError(`writing ${operation}`)),
    Effect.catchIf(
      (error) => isBrokenPipeCause(error.cause),
      () => Effect.void
    )
  );
});

export const CliIoLive: Layer.Layer<CliIo, never, Stdio> = Layer.effect(CliIo)(
  Effect.gen(function* () {
    const stdio = yield* Stdio;

    return CliIo.of({
      isStdinTty: Effect.sync(() => globalThis.process.stdin.isTTY ?? false),
      isStdoutTty: Effect.sync(() => globalThis.process.stdout.isTTY ?? false),
      readStdin: readStdinText(stdio),
      writeStderr: (text) => writeSink(stdio.stderr(), "stderr", text),
      writeStdout: (text) => writeSink(stdio.stdout(), "stdout", text),
    });
  })
);
