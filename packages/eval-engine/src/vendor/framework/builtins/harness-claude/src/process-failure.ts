import type { AgentFailure } from "../../ori/src/index.ts";

import { agentFailure, isContextOverflowMessage } from "../../ori/src/index.ts";

import { isClaudeMissingSessionMessage } from "./failure.ts";

/**
 * What ORI knows about a finished Claude process.
 *
 * `timedOut`, `exitCode`, and `missingBinary` are typed facts the process
 * boundary already had, so they are not re-parsed out of `message`: a stderr
 * tail mentioning a deprecated `apiTimeout` config key must not turn an exit-1
 * crash into a timeout.
 */
export interface ClaudeProcessOutcome {
  readonly exitCode?: number | undefined;
  /** Rendered diagnostic text; used only for classification, never forwarded. */
  readonly message: string;
  readonly missingBinary?: boolean | undefined;
  readonly timedOut: boolean;
}

const NO_RESULT_PATTERN = /exited without emitting a result event/iu;

export const claudeProcessFailure = (
  outcome: ClaudeProcessOutcome
): AgentFailure => {
  const upstreamCode = outcome.exitCode;

  if (outcome.missingBinary === true) {
    return agentFailure({
      code: "ORI_CLAUDE_BINARY_UNAVAILABLE",
      message: "The Claude executable was not found.",
      remediation:
        "Install it with `bun add -g --trust @anthropic-ai/claude-code`, or set ORI_CLAUDE_BIN.",
      stage: "harness",
    });
  }
  if (outcome.timedOut) {
    return agentFailure({
      code: "ORI_CLAUDE_PROCESS_TIMEOUT",
      message: "Claude timed out before completing the request.",
      remediation: "Raise ORI_CLAUDE_TIMEOUT_MS or simplify the request.",
      stage: "harness",
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
  }
  if (isClaudeMissingSessionMessage(outcome.message)) {
    return agentFailure({
      code: "ORI_SESSION_NOT_FOUND",
      message: "Claude could not find the requested session.",
      remediation: "Start a new session instead of resuming this one.",
      stage: "harness",
    });
  }
  if (NO_RESULT_PATTERN.test(outcome.message)) {
    return agentFailure({
      code: "ORI_CLAUDE_NO_RESULT_EVENT",
      stage: "harness",
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
  }
  if (isContextOverflowMessage(outcome.message)) {
    return agentFailure({
      code: "ORI_CONTEXT_OVERFLOW",
      stage: "harness",
    });
  }
  return agentFailure({
    code: "ORI_CLAUDE_PROCESS_FAILED",
    message:
      upstreamCode === undefined
        ? "Claude exited before completing the request."
        : `Claude exited with code ${upstreamCode} before completing the request.`,
    stage: "harness",
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
  });
};
