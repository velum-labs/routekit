import type { AgentFailure } from "../../../ori/src/index.ts";
import type { HarnessProcessResult } from "../../../ori/src/process.ts";

import {
  agentFailure,
  isContextOverflowMessage,
  isMissingSessionMessage,
} from "../../../ori/src/index.ts";
import { stderrTail } from "../../../ori/src/process.ts";

import { parseAffordableMaxTokens } from "../model/model.ts";
import { formatSafeErrorDiagnostic } from "../../../../utils/core/src/error-formatting.ts";

import type { PiRuntime } from "./pi-runtime.ts";

import { withRuntimeHint } from "./pi-runtime.ts";

/**
 * Render what a finished Pi process says about its own failure, or `undefined`
 * when it did not fail. The text is a diagnostic: `piProcessFailure` classifies
 * it, and no consumer parses it.
 */
export const processResultError = (
  result: HarnessProcessResult,
  effectiveRuntime: PiRuntime
): string | undefined => {
  const stderr = stderrTail(result.stderr);
  if (result.timedOut) {
    return stderr === undefined
      ? "Pi process timed out."
      : `Pi process timed out. stderr: ${stderr}`;
  }

  if (result.exitCode === 0) {
    return undefined;
  }

  if (result.exitCode === null) {
    return withRuntimeHint(
      stderr ?? "Pi process exited unexpectedly.",
      effectiveRuntime,
      result.stderr
    );
  }

  const base =
    stderr === undefined
      ? `Pi process exited with code ${result.exitCode}.`
      : `Pi process exited with code ${result.exitCode}. stderr: ${stderr}`;
  return withRuntimeHint(base, effectiveRuntime, result.stderr);
};

/**
 * The same diagnostic, safe to log: the text is Pi's own output and it echoes
 * request URLs and provider bodies.
 */
export const redactedProcessDiagnostic = (error: unknown): string =>
  formatSafeErrorDiagnostic(error);

/**
 * What ORI knows about a finished Pi process.
 *
 * `timedOut` and `exitCode` are typed facts the process boundary already had.
 * They are passed through rather than re-parsed out of `message`, so a stderr
 * tail that happens to contain the word "timeout" cannot reclassify a crash.
 */
export interface PiProcessOutcome {
  readonly exitCode?: number | undefined;
  /** Rendered diagnostic text; used only for classification, never forwarded. */
  readonly message: string;
  readonly missingBinary?: boolean | undefined;
  readonly timedOut: boolean;
}

export const piProcessFailure = (outcome: PiProcessOutcome): AgentFailure => {
  const retryWithMaxOutputTokens = parseAffordableMaxTokens(outcome.message);
  const upstreamCode = outcome.exitCode;

  if (outcome.missingBinary === true) {
    return agentFailure({
      code: "ORI_PI_BINARY_UNAVAILABLE",
      message: "The Pi executable was not found.",
      remediation: "Set ORI_PI_BIN to a working Pi executable or reinstall Pi.",
      stage: "harness",
    });
  }
  if (outcome.timedOut) {
    return agentFailure({
      code: "ORI_PI_PROCESS_TIMEOUT",
      message: "Pi timed out before completing the request.",
      remediation: "Raise ORI_PI_TIMEOUT_MS or simplify the request.",
      stage: "harness",
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
  }
  if (isMissingSessionMessage(outcome.message)) {
    return agentFailure({
      code: "ORI_SESSION_NOT_FOUND",
      message: "Pi could not find the requested session.",
      remediation: "Start a new session instead of resuming this one.",
      stage: "harness",
    });
  }
  if (isContextOverflowMessage(outcome.message)) {
    return agentFailure({
      code: "ORI_CONTEXT_OVERFLOW",
      stage: "harness",
      ...(retryWithMaxOutputTokens === undefined
        ? {}
        : { retryWithMaxOutputTokens }),
    });
  }
  return agentFailure({
    code: "ORI_PI_PROCESS_FAILED",
    message:
      upstreamCode === undefined
        ? "Pi exited before completing the request."
        : `Pi exited with code ${upstreamCode} before completing the request.`,
    ...(retryWithMaxOutputTokens === undefined
      ? {}
      : { retryWithMaxOutputTokens }),
    stage: "harness",
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
  });
};
