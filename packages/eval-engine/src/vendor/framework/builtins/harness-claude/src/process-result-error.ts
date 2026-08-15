import type { AgentFailure } from "../../ori/src/index.ts";
import type { HarnessProcessResult } from "../../ori/src/process.ts";

import { stderrTail } from "../../ori/src/process.ts";

import { claudeProcessFailure } from "./process-failure.ts";

const processResultError = (
  result: HarnessProcessResult,
  emittedTerminalEvent: boolean
): string | undefined => {
  const stderr = stderrTail(result.stderr);
  if (result.timedOut) {
    return stderr === undefined
      ? "Claude process timed out."
      : `Claude process timed out. stderr: ${stderr}`;
  }

  if (result.exitCode === 0) {
    return emittedTerminalEvent
      ? undefined
      : "Claude process exited without emitting a result event.";
  }

  if (result.exitCode === null) {
    return stderr ?? "Claude process exited unexpectedly.";
  }

  return stderr === undefined
    ? `Claude process exited with code ${result.exitCode}.`
    : `Claude process exited with code ${result.exitCode}. stderr: ${stderr}`;
};

/**
 * How a finished process settles the turn: succeeded, or failed with the
 * classified failure built from the typed facts the process boundary already had
 * (exit code, timeout flag, missing binary) rather than re-parsed out of the
 * text. Lives here rather than at the call site so the harness reads as "run the
 * process, finalize the state".
 */
const claudeProcessOutcome = (
  result: HarnessProcessResult,
  error: string | undefined
):
  | { readonly failure: AgentFailure; readonly ok: false }
  | { readonly ok: true } =>
  error === undefined
    ? { ok: true }
    : {
        failure: claudeProcessFailure({
          // A clean exit that never sent a result is still a failure, but it
          // has no upstream code: forwarding the 0 renders `upstream=0`, which
          // reads as an error code and sends the reader looking for one.
          ...(result.exitCode === null || result.exitCode === 0
            ? {}
            : { exitCode: result.exitCode }),
          message: error,
          missingBinary: result.missingBinary,
          timedOut: result.timedOut,
        }),
        ok: false,
      };

export { claudeProcessOutcome, processResultError };
