import type { AgentFailure, AgentFailureCode } from "../../../ori/src/index.ts";

import {
  agentFailure,
  isContextOverflowMessage,
  isMissingSessionMessage,
} from "../../../ori/src/index.ts";

import { parseAffordableMaxTokens } from "../model/model.ts";

/**
 * Pi renders provider failures as prose with the HTTP status in front, and
 * that status is the only machine-readable fact in the string. Lifting it into
 * `upstreamCode` is what lets an operator tell a 401 from a 429 once the prose
 * itself is dropped as unsafe to forward.
 *
 * Anchored, because a 4xx/5xx-shaped integer occurs in Pi prose that has no
 * status at all: "you requested up to 32768 tokens, but can only afford 500"
 * would otherwise be reported to an operator as HTTP 500.
 */
const UPSTREAM_STATUS_PATTERN = /^\s*(4\d{2}|5\d{2})\b/u;

const parseUpstreamStatus = (rawMessage: string): number | undefined => {
  const matched = UPSTREAM_STATUS_PATTERN.exec(rawMessage);
  if (matched?.[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(matched[1], 10);
};

interface PiFailureOptions {
  readonly kind?: AgentFailure["kind"];
  readonly retryable?: boolean | undefined;
  readonly stage?: AgentFailure["stage"];
}

/**
 * A compaction that failed for a provider reason is still a compaction
 * failure, so its text is never run through the turn-level classifiers: a
 * summary request that overflowed would come back as `ORI_CONTEXT_OVERFLOW`
 * with the code's own retryability, renaming the operation and discarding the
 * `willRetry` Pi reported for it.
 */
export const piCompactionFailure = (
  rawMessage: string,
  willRetry: boolean | undefined
): AgentFailure => {
  const retryWithMaxOutputTokens = parseAffordableMaxTokens(rawMessage);
  const upstreamCode = parseUpstreamStatus(rawMessage);
  return agentFailure({
    code: "ORI_PI_COMPACTION_FAILED",
    kind: "internal",
    ...(retryWithMaxOutputTokens === undefined
      ? {}
      : { retryWithMaxOutputTokens }),
    ...(willRetry === undefined ? {} : { retryable: willRetry }),
    stage: "harness",
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
  });
};

/**
 * Classify raw Pi provider text, falling back to `code` when it names no
 * condition ORI recognizes. Callers that already know which operation failed
 * must not use this: it can rename the failure.
 */
export const piFailure = (
  code: AgentFailureCode,
  rawMessage: string,
  options: PiFailureOptions = {}
): AgentFailure => {
  const retryWithMaxOutputTokens = parseAffordableMaxTokens(rawMessage);
  const upstreamCode = parseUpstreamStatus(rawMessage);

  if (isMissingSessionMessage(rawMessage)) {
    return agentFailure({
      code: "ORI_SESSION_NOT_FOUND",
      message: "Pi could not find the requested session.",
      remediation: "Start a new session instead of resuming this one.",
      stage: "harness",
    });
  }
  if (isContextOverflowMessage(rawMessage)) {
    return agentFailure({
      code: "ORI_CONTEXT_OVERFLOW",
      stage: options.stage ?? "harness",
      ...(retryWithMaxOutputTokens === undefined
        ? {}
        : { retryWithMaxOutputTokens }),
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
  }
  return agentFailure({
    code,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(retryWithMaxOutputTokens === undefined
      ? {}
      : { retryWithMaxOutputTokens }),
    ...(options.retryable === undefined
      ? {}
      : { retryable: options.retryable }),
    stage: options.stage ?? "harness",
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
  });
};
