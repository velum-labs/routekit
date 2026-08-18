import type { AgentFailure, AgentFailureCode, AgentFailureStage } from "../../ori/src/index.ts";

import {
  agentFailure,
  isContextOverflowMessage,
  isMissingSessionMessage,
} from "../../ori/src/index.ts";

export const isClaudeMissingSessionMessage = (message: string): boolean =>
  isMissingSessionMessage(message);

interface ClaudeFailureOptions {
  readonly kind?: AgentFailure["kind"] | undefined;
  /** Where ORI observed it; provider-originated events must say so. */
  readonly stage?: AgentFailureStage | undefined;
  readonly upstreamCode?: number | string | undefined;
}

/**
 * Classify raw Claude text, falling back to `code` when it names no condition
 * ORI recognizes. Callers that already know which operation failed must not
 * use this: it can rename the failure.
 */
export const claudeFailure = (
  code: AgentFailureCode,
  rawMessage: string,
  options: ClaudeFailureOptions = {}
): AgentFailure => {
  if (isClaudeMissingSessionMessage(rawMessage)) {
    return agentFailure({
      code: "ORI_SESSION_NOT_FOUND",
      message: "Claude could not find the requested session.",
      remediation: "Start a new session instead of resuming this one.",
      stage: "harness",
    });
  }
  if (isContextOverflowMessage(rawMessage)) {
    return agentFailure({
      code: "ORI_CONTEXT_OVERFLOW",
      stage: options.stage ?? "harness",
      ...(options.upstreamCode === undefined
        ? {}
        : { upstreamCode: options.upstreamCode }),
    });
  }
  return agentFailure({
    code,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    stage: options.stage ?? "harness",
    ...(options.upstreamCode === undefined
      ? {}
      : { upstreamCode: options.upstreamCode }),
  });
};
