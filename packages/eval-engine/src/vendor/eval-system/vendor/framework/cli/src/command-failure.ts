import { Effect, Terminal } from "effect";

import type { OutputMode } from "../../contracts/internal/src/cli/output-mode.ts";

import { CliIo } from "../../contracts/internal/src/cli/cli-io.ts";
import { formatCliFailure } from "../../contracts/internal/src/cli/cli-messages.ts";
import {
  CliOutputAlreadyReported,
  renderErrorEnvelope,
  toEnvelopeError,
} from "../../contracts/internal/src/cli/cli-output.ts";
import { currentOutputMode } from "../../contracts/internal/src/cli/output-mode.ts";
import { RouteKitEvalCliExit } from "./cli-exit.ts";

const reportFailure = Effect.fn("CommandFailure.report")(function* (
  command: string,
  failure: unknown
) {
  if (failure instanceof RouteKitEvalCliExit) {
    return yield* failure;
  }
  if (Terminal.isQuitError(failure)) {
    return yield* failure;
  }
  if (failure instanceof CliOutputAlreadyReported) {
    return yield* new CliOutputAlreadyReported({
      cause: failure.cause,
      command: failure.command ?? command,
    });
  }

  const cliIo = yield* CliIo;
  const mode = yield* currentOutputMode();
  yield* (
    mode === "json"
      ? cliIo.writeStdout(
          renderErrorEnvelope(command, toEnvelopeError(failure))
        )
      : cliIo.writeStderr(`${formatCliFailure(failure)}\n`)
  ).pipe(Effect.ignore);

  return yield* new CliOutputAlreadyReported({
    cause: failure,
    command,
  });
});

/**
 * Reports a command handler's typed failure in the active output mode, then
 * marks it as already emitted for the process boundary. Deliberate exits and
 * terminal cancellation pass through; reported output gains the command label.
 */
export const reportCommandFailure =
  (command: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    CliOutputAlreadyReported | RouteKitEvalCliExit | Terminal.QuitError,
    R | CliIo | OutputMode
  > =>
    effect.pipe(Effect.catch((error) => reportFailure(command, error)));
