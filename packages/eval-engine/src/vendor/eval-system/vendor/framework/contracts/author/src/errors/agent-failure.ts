import type {
  AgentFailureCode,
  AgentFailureCodeSpec,
  AgentFailureKind,
  AgentFailureStage,
} from "./agent-failure-codes.ts";

import { AGENT_FAILURE_CODES } from "./agent-failure-codes.ts";

export const MAX_AGENT_FAILURE_TEXT_LENGTH = 256;

const boundAgentFailureText = (value: string): string =>
  value.slice(0, MAX_AGENT_FAILURE_TEXT_LENGTH);

/**
 * Which failure best explains a run when several describe it.
 *
 * Higher wins. A cause the operator can act on outranks the symptom it
 * produced: a rejected upstream request outranks the severed stream that
 * followed it.
 *
 * `cancelled` is not on this ladder. Its relationship to a fault depends on
 * which came first, so {@link selectMoreSpecificAgentFailure} settles that case
 * before any rank is compared.
 */
const AGENT_FAILURE_KIND_RANK: Record<AgentFailureKind, number> = {
  cancelled: 5,
  configuration: 4,
  internal: 1,
  "invalid-input": 4,
  "not-found": 4,
  protocol: 3,
  timeout: 3,
  unavailable: 2,
  unknown: 0,
  upstream: 4,
};

/** Boundaries closer to the origin of a failure explain it better. */
const AGENT_FAILURE_STAGE_RANK: Record<AgentFailureStage, number> = {
  adapter: 2,
  harness: 3,
  provider: 4,
  runtime: 1,
  tool: 2,
};

/**
 * A safe, structured failure that can cross process, journal, API, and chat
 * boundaries without relying on a human message as its machine contract.
 *
 * `message` and `remediation` are display-safe summaries, not raw upstream
 * payloads. The event envelope already carries harness/model attribution, so
 * those facts are not duplicated here.
 */
export interface AgentFailure {
  /** Stable ROUTEKIT_EVAL-owned lookup key from `AGENT_FAILURE_CODES`. */
  readonly code: AgentFailureCode;
  readonly kind: AgentFailureKind;
  /** Short, sanitized description suitable for logs and user interfaces. */
  readonly message: string;
  /** Safe next action when ROUTEKIT_EVAL can offer one. */
  readonly remediation?: string | undefined;
  /** Safe max-output-token cap to use for a retry, when the provider supplies one. */
  readonly retryWithMaxOutputTokens?: number | undefined;
  /** Whether retrying the same operation may succeed. */
  readonly retryable?: boolean | undefined;
  /** Boundary where ROUTEKIT_EVAL observed the failure. */
  readonly stage: AgentFailureStage;
  /** Error code supplied by the immediately upstream system, when known. */
  readonly upstreamCode?: number | string | undefined;
}

export interface AgentFailureInput {
  readonly code: AgentFailureCode;
  /** Overrides the code's declared kind. Needed only when one code spans kinds. */
  readonly kind?: AgentFailureKind | undefined;
  /** Defaults to the code's `summary`. */
  readonly message?: string | undefined;
  readonly remediation?: string | undefined;
  readonly retryWithMaxOutputTokens?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly stage: AgentFailureStage;
  readonly upstreamCode?: number | string | undefined;
}

/**
 * Build a failure from its code, filling `kind`, `retryable`, and the default
 * `message` from `AGENT_FAILURE_CODES` and applying the public text bounds.
 *
 * This is the only supported way to construct an `AgentFailure`. Going through
 * it is what keeps one condition from arriving as `retryable: true` at one
 * boundary and `undefined` at another.
 */
export const agentFailure = (input: AgentFailureInput): AgentFailure => {
  const spec: AgentFailureCodeSpec = AGENT_FAILURE_CODES[input.code];
  const retryable = input.retryable ?? spec.retryable;
  const remediation = input.remediation ?? spec.remediation;
  return {
    code: input.code,
    kind: input.kind ?? spec.kind,
    message: boundAgentFailureText(input.message ?? spec.summary),
    ...(remediation === undefined
      ? {}
      : { remediation: boundAgentFailureText(remediation) }),
    ...(input.retryWithMaxOutputTokens === undefined
      ? {}
      : { retryWithMaxOutputTokens: input.retryWithMaxOutputTokens }),
    ...(retryable === undefined ? {} : { retryable }),
    stage: input.stage,
    ...(input.upstreamCode === undefined
      ? {}
      : {
          upstreamCode:
            typeof input.upstreamCode === "string"
              ? boundAgentFailureText(input.upstreamCode)
              : input.upstreamCode,
        }),
  };
};

/**
 * Enforce the public diagnostic bounds on an already-safe ROUTEKIT_EVAL-owned failure.
 *
 * This does not redact external text. Callers must classify external failures
 * first and pass only safe summaries and allowlisted structured facts.
 */
export const boundAgentFailure = (failure: AgentFailure): AgentFailure => ({
  ...failure,
  message: boundAgentFailureText(failure.message),
  ...(failure.remediation === undefined
    ? {}
    : { remediation: boundAgentFailureText(failure.remediation) }),
  ...(typeof failure.upstreamCode === "string"
    ? { upstreamCode: boundAgentFailureText(failure.upstreamCode) }
    : {}),
});

const agentFailureSpecificity = (failure: AgentFailure): number =>
  [
    failure.retryable,
    failure.retryWithMaxOutputTokens,
    failure.upstreamCode,
  ].filter((value) => value !== undefined).length;

const agentFailureRank = (
  failure: AgentFailure
): readonly [number, number, number, number] => [
  AGENT_FAILURE_KIND_RANK[failure.kind],
  failure.remediation === undefined ? 0 : 1,
  AGENT_FAILURE_STAGE_RANK[failure.stage],
  agentFailureSpecificity(failure),
];

/**
 * Keep the failure that best explains the run.
 *
 * Ranked by cause, then by whether the failure tells the reader what to do,
 * then by boundary, then by remaining detail. A well-classified failure wins
 * even when a vaguer one happens to carry more optional fields, because
 * counting populated fields measures how chatty a mapper is, not how well it
 * identified the fault. `remediation` sits above the boundary tiebreak because
 * the boundary says where ROUTEKIT_EVAL stood when it saw the fault, while a remediation
 * is the next action the surface exists to deliver: ranking the boundary first
 * answered a Pi provider rejection with the arm that named no upstream code and
 * offered no way out.
 *
 * A cancellation is settled before any of that. It is the one outcome that is
 * not a fault, so it explains a run that has no fault recorded and loses to one
 * that does — in either order. Arrival order looks like it should decide this,
 * but no transport guarantees it: an abort can be observed ahead of the
 * upstream rejection that actually killed the turn just as easily as behind the
 * fault it tore down. Ranking the fault regardless is the answer that never
 * files a broken run under "the user changed their mind".
 */
export const selectMoreSpecificAgentFailure = (
  current: AgentFailure | undefined,
  candidate: AgentFailure
): AgentFailure => {
  if (current === undefined) {
    return candidate;
  }
  const cancellations =
    Number(current.kind === "cancelled") +
    Number(candidate.kind === "cancelled");
  if (cancellations === 1) {
    return current.kind === "cancelled" ? candidate : current;
  }
  const currentRank = agentFailureRank(current);
  const candidateRank = agentFailureRank(candidate);
  for (const [index, currentValue] of currentRank.entries()) {
    const candidateValue = candidateRank[index] ?? 0;
    if (candidateValue !== currentValue) {
      return candidateValue > currentValue ? candidate : current;
    }
  }
  return current;
};

/** The `key=value` diagnostic tail, without the message or remediation. */
export const formatAgentFailureContext = (failure: AgentFailure): string =>
  [
    `code=${failure.code}`,
    `kind=${failure.kind}`,
    `stage=${failure.stage}`,
    failure.upstreamCode === undefined
      ? undefined
      : `upstream=${failure.upstreamCode}`,
    failure.retryable === undefined
      ? undefined
      : `retryable=${failure.retryable}`,
    failure.retryWithMaxOutputTokens === undefined
      ? undefined
      : `retry-max-output-tokens=${failure.retryWithMaxOutputTokens}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

/**
 * Render the safe diagnostic context a human needs to report or investigate a
 * failure. Multi-line: use `formatAgentFailureLine` where the surface is a
 * single line, such as a Slack footer or a table cell.
 */
export const formatAgentFailure = (failure: AgentFailure): string => {
  const remediation =
    failure.remediation === undefined ? "" : `\nTry: ${failure.remediation}`;
  return `${failure.message}\n${formatAgentFailureContext(failure)}${remediation}`;
};

/**
 * One-line rendering for surfaces that cannot take a newline: Slack footers,
 * table cells, and HTTP error details.
 */
export const formatAgentFailureLine = (failure: AgentFailure): string => {
  const remediation =
    failure.remediation === undefined ? "" : ` · try: ${failure.remediation}`;
  return `${failure.message} (${formatAgentFailureContext(failure)})${remediation}`;
};
