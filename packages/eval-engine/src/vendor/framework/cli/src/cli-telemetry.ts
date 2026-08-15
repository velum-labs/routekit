import type { Crypto as CryptoService, Result } from "effect";

import { Cause, Clock, Effect, Schema } from "effect";

import type { TelemetryShape } from "./telemetry/telemetry.ts";
import type { TelemetryProps } from "./telemetry/telemetry-event.ts";

import { HostProcess } from "../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../contracts/internal/src/errors.ts";
import { classifyCliTelemetryOutcome } from "./cli-telemetry-decisions.ts";
import {
  makeStackFingerprint,
  sanitizeCliError,
  stableErrorClass,
} from "./telemetry/telemetry-error.ts";

const agentFailureCode = (failure: unknown): string | undefined =>
  Schema.is(CliFailureError)(failure) ? failure.failureCode : undefined;

export const makeCliErrorProps = Effect.fn("CliTelemetry.makeCliErrorProps")(
  function* (failure: unknown, command: string) {
    const hostProcess = yield* HostProcess;
    const sanitized = sanitizeCliError({
      error: failure,
      homeDirectory: yield* hostProcess.homeDirectory,
    });
    const stackFingerprint = yield* makeStackFingerprint(
      sanitized.stackForFingerprint
    );
    // The failure code outranks the wrapper's tag. Every agent-run failure
    // reaches the top level as one `CliFailureError`, so grouping on the tag
    // puts a rejected credential, an exhausted balance, and a crashed peer in
    // one bucket that no dashboard can split apart again.
    const errorClass =
      agentFailureCode(failure) ??
      stableErrorClass(sanitized, stackFingerprint);
    return {
      cause_chain: sanitized.causeChain,
      command,
      error_class: errorClass,
      ...(sanitized.exitCode === undefined
        ? {}
        : { exit_code: sanitized.exitCode }),
      message: sanitized.message,
      stack: sanitized.stack,
      stack_fingerprint: stackFingerprint,
    } satisfies TelemetryProps;
  }
);

export const emitCommandTelemetry = Effect.fn(
  "CliTelemetry.emitCommandTelemetry"
)(function* ({
  cancelled,
  durationMs,
  failure,
  telemetry,
  command,
}: {
  readonly command: string;
  readonly durationMs: number;
  readonly failure: unknown;
  readonly cancelled?: boolean;
  readonly telemetry: TelemetryShape;
}) {
  const outcome = classifyCliTelemetryOutcome(
    cancelled === undefined
      ? { failure }
      : {
          cancelled,
          failure,
        }
  );
  const errorProps =
    outcome === "error"
      ? yield* makeCliErrorProps(failure, command).pipe(
          Effect.catchCause(() => Effect.succeed(null))
        )
      : null;
  yield* telemetry.emit("cli_command", {
    command,
    duration_ms: durationMs,
    outcome,
    ...(errorProps?.error_class === undefined
      ? {}
      : { error_class: errorProps.error_class }),
  });
  if (errorProps !== null) {
    yield* telemetry
      .emit("cli_error", errorProps)
      .pipe(Effect.catchCause(() => Effect.void));
  }
});

export const runCliProgramWithTelemetry = <A, E, R>(input: {
  readonly command: string;
  readonly program: Effect.Effect<A, E, R>;
  readonly startedAt: number;
  readonly telemetry: TelemetryShape;
}): Effect.Effect<
  Result.Result<A, E>,
  E,
  R | CryptoService.Crypto | HostProcess
> =>
  input.program.pipe(
    Effect.result,
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const durationMs = (yield* Clock.currentTimeMillis) - input.startedAt;
        const failure = Cause.squash(cause);
        yield* emitCommandTelemetry({
          cancelled: Cause.hasInterrupts(cause),
          command: input.command,
          durationMs,
          failure,
          telemetry: input.telemetry,
        }).pipe(Effect.catchCause(() => Effect.void));
        return yield* Effect.failCause(cause);
      })
    )
  );
