export const AGENT_FAILURE_KINDS = [
  "cancelled",
  "configuration",
  "internal",
  "invalid-input",
  "not-found",
  "protocol",
  "timeout",
  "unavailable",
  "unknown",
  "upstream",
] as const;

export const AGENT_FAILURE_STAGES = [
  "adapter",
  "harness",
  "provider",
  "runtime",
  "tool",
] as const;

export type AgentFailureKind = (typeof AGENT_FAILURE_KINDS)[number];
export type AgentFailureStage = (typeof AGENT_FAILURE_STAGES)[number];

/**
 * The closed index of ROUTEKIT_EVAL failure codes.
 *
 * A code is the stable key a human greps for, so it lives here rather than at
 * its throw site: adding one is a deliberate edit to a reviewed list, and a
 * typo is a type error.
 */
export const AGENT_FAILURE_CODE_LIST = [
  "ROUTEKIT_EVAL_ADAPTER_CAPACITY",
  "ROUTEKIT_EVAL_ADAPTER_CLOSED",
  "ROUTEKIT_EVAL_ADAPTER_CONFIG",
  "ROUTEKIT_EVAL_ADAPTER_CONNECTION",
  "ROUTEKIT_EVAL_ADAPTER_INITIALIZATION",
  "ROUTEKIT_EVAL_ADAPTER_INVALID_STATE",
  "ROUTEKIT_EVAL_ADAPTER_MALFORMED_INPUT",
  "ROUTEKIT_EVAL_ADAPTER_PEER_EXIT",
  "ROUTEKIT_EVAL_ADAPTER_PROTOCOL",
  "ROUTEKIT_EVAL_ADAPTER_PROTOCOL_VERSION",
  "ROUTEKIT_EVAL_ADAPTER_REMOTE_ERROR",
  "ROUTEKIT_EVAL_ADAPTER_RETRY_FAILED",
  "ROUTEKIT_EVAL_ADAPTER_TRANSPORT",
  "ROUTEKIT_EVAL_ADAPTER_UNAUTHORIZED",
  "ROUTEKIT_EVAL_CLAUDE_BINARY_UNAVAILABLE",
  "ROUTEKIT_EVAL_CLAUDE_NO_RESULT_EVENT",
  "ROUTEKIT_EVAL_CLAUDE_PLUGIN_INSTALL_FAILED",
  "ROUTEKIT_EVAL_CLAUDE_PROCESS_FAILED",
  "ROUTEKIT_EVAL_CLAUDE_PROCESS_TIMEOUT",
  "ROUTEKIT_EVAL_CLAUDE_RUNTIME_ERROR",
  "ROUTEKIT_EVAL_CLAUDE_SESSION_FAILED",
  "ROUTEKIT_EVAL_CLAUDE_TURN_LIMIT",
  "ROUTEKIT_EVAL_COMPACTION_FAILED",
  "ROUTEKIT_EVAL_COMPACTION_SUMMARY_FAILED",
  "ROUTEKIT_EVAL_CONTEXT_OVERFLOW",
  "ROUTEKIT_EVAL_HARNESS_CAPABILITY_UNSUPPORTED",
  "ROUTEKIT_EVAL_HARNESS_PROCESS_FAILED",
  "ROUTEKIT_EVAL_HARNESS_PROTOCOL_FAILED",
  "ROUTEKIT_EVAL_HARNESS_VALIDATION_FAILED",
  "ROUTEKIT_EVAL_LEGACY_RUNTIME_DIAGNOSTIC",
  "ROUTEKIT_EVAL_LEGACY_SCHEDULE_FIRE_FAILED",
  "ROUTEKIT_EVAL_LEGACY_TURN_FAILED",
  "ROUTEKIT_EVAL_BEARER_TOKEN_MISSING",
  "ROUTEKIT_EVAL_GATEWAY_CREDITS_EXHAUSTED",
  "ROUTEKIT_EVAL_PI_BINARY_UNAVAILABLE",
  "ROUTEKIT_EVAL_PI_COMPACTION_FAILED",
  "ROUTEKIT_EVAL_PI_PROCESS_FAILED",
  "ROUTEKIT_EVAL_PI_PROCESS_TIMEOUT",
  "ROUTEKIT_EVAL_PI_PROVIDER_ERROR",
  "ROUTEKIT_EVAL_REQUEST_CANCELLED",
  "ROUTEKIT_EVAL_RUNTIME_ENVIRONMENT_FAILED",
  "ROUTEKIT_EVAL_RUNTIME_INVOKE_FAILED",
  "ROUTEKIT_EVAL_RUNTIME_SECRET_FAILED",
  "ROUTEKIT_EVAL_RUNTIME_STREAM_SEVERED",
  "ROUTEKIT_EVAL_RUNTIME_VALIDATION_FAILED",
  "ROUTEKIT_EVAL_SCHEDULE_FIRE_FAILED",
  "ROUTEKIT_EVAL_SESSION_NOT_FOUND",
  "ROUTEKIT_EVAL_SLACK_AGENT_STREAM_FAILED",
] as const;

export type AgentFailureCode = (typeof AGENT_FAILURE_CODE_LIST)[number];

export interface AgentFailureCodeSpec {
  /** Default classification for the code, overridable per occurrence. */
  readonly kind: AgentFailureKind;
  /** Default next step when the code alone determines it. */
  readonly remediation?: string;
  /** Default retry answer when the code alone determines it. */
  readonly retryable?: boolean;
  /** One-line meaning; the default `message` and the docs index entry. */
  readonly summary: string;
}

/**
 * Declared meaning of each code. `kind` and `retryable` live here so the same
 * condition cannot be classified differently by two boundaries.
 */
export const AGENT_FAILURE_CODES = {
  ROUTEKIT_EVAL_ADAPTER_CAPACITY: {
    kind: "unavailable",
    retryable: true,
    summary: "An adapter queue reached its capacity limit.",
  },
  ROUTEKIT_EVAL_ADAPTER_CLOSED: {
    kind: "unavailable",
    retryable: true,
    summary: "The adapter connection closed before the request finished.",
  },
  ROUTEKIT_EVAL_ADAPTER_CONFIG: {
    kind: "configuration",
    retryable: false,
    summary: "The adapter connection is misconfigured.",
  },
  ROUTEKIT_EVAL_ADAPTER_CONNECTION: {
    kind: "unavailable",
    retryable: true,
    summary: "The selected adapter connection failed.",
  },
  ROUTEKIT_EVAL_ADAPTER_INITIALIZATION: {
    kind: "protocol",
    retryable: false,
    summary: "The adapter peer failed to initialize.",
  },
  ROUTEKIT_EVAL_ADAPTER_INVALID_STATE: {
    kind: "internal",
    retryable: false,
    summary: "The selected adapter entered an invalid state.",
  },
  ROUTEKIT_EVAL_ADAPTER_MALFORMED_INPUT: {
    kind: "invalid-input",
    retryable: false,
    summary: "The selected adapter received invalid input.",
  },
  ROUTEKIT_EVAL_ADAPTER_PEER_EXIT: {
    kind: "unavailable",
    retryable: true,
    summary: "The adapter peer process exited before finishing the request.",
  },
  ROUTEKIT_EVAL_ADAPTER_PROTOCOL: {
    kind: "protocol",
    retryable: false,
    summary: "The adapter peer violated the ACP protocol.",
  },
  ROUTEKIT_EVAL_ADAPTER_PROTOCOL_VERSION: {
    kind: "protocol",
    retryable: false,
    summary: "The adapter peer speaks an unsupported ACP protocol version.",
  },
  ROUTEKIT_EVAL_ADAPTER_REMOTE_ERROR: {
    kind: "upstream",
    summary: "The adapter peer rejected the request.",
  },
  ROUTEKIT_EVAL_ADAPTER_RETRY_FAILED: {
    kind: "upstream",
    retryable: false,
    summary: "The adapter exhausted its retry attempts.",
  },
  ROUTEKIT_EVAL_ADAPTER_TRANSPORT: {
    kind: "unavailable",
    retryable: true,
    summary: "The adapter transport failed mid-request.",
  },
  ROUTEKIT_EVAL_ADAPTER_UNAUTHORIZED: {
    kind: "configuration",
    retryable: false,
    summary: "The upstream provider rejected the configured credential.",
  },
  ROUTEKIT_EVAL_CLAUDE_BINARY_UNAVAILABLE: {
    kind: "configuration",
    retryable: false,
    summary: "The Claude binary is missing or not executable.",
  },
  ROUTEKIT_EVAL_CLAUDE_NO_RESULT_EVENT: {
    kind: "protocol",
    retryable: true,
    summary: "Claude exited without emitting a result event.",
  },
  ROUTEKIT_EVAL_CLAUDE_PLUGIN_INSTALL_FAILED: {
    kind: "configuration",
    retryable: false,
    summary: "Claude could not install a required plugin.",
  },
  ROUTEKIT_EVAL_CLAUDE_PROCESS_FAILED: {
    kind: "unavailable",
    retryable: true,
    summary: "The Claude process exited before completing the request.",
  },
  ROUTEKIT_EVAL_CLAUDE_PROCESS_TIMEOUT: {
    kind: "timeout",
    retryable: true,
    summary: "The Claude process exceeded its time budget.",
  },
  ROUTEKIT_EVAL_CLAUDE_RUNTIME_ERROR: {
    kind: "upstream",
    summary: "Claude reported a runtime error mid-turn.",
  },
  ROUTEKIT_EVAL_CLAUDE_SESSION_FAILED: {
    kind: "upstream",
    summary: "Claude ended the session with an error result.",
  },
  ROUTEKIT_EVAL_CLAUDE_TURN_LIMIT: {
    kind: "configuration",
    retryable: false,
    summary: "Claude stopped after reaching the configured turn limit.",
  },
  ROUTEKIT_EVAL_COMPACTION_FAILED: {
    kind: "internal",
    summary: "Context compaction failed.",
  },
  ROUTEKIT_EVAL_COMPACTION_SUMMARY_FAILED: {
    kind: "internal",
    // The rollover always falls back to the journal projection, so the only
    // producer of this code retries by construction.
    retryable: true,
    summary: "ROUTEKIT_EVAL could not summarize the transcript for compaction.",
  },
  ROUTEKIT_EVAL_CONTEXT_OVERFLOW: {
    kind: "upstream",
    // Without a remediation this loses the rank tiebreak to any generic
    // upstream rejection that carries one, and a surface keying off the code
    // (Slack's `context-overflow`) reports the vaguer failure instead.
    remediation:
      "Compact or start a new session, or lower the request's output cap.",
    retryable: true,
    summary: "The request exceeds the model context window.",
  },
  ROUTEKIT_EVAL_HARNESS_CAPABILITY_UNSUPPORTED: {
    kind: "invalid-input",
    retryable: false,
    summary: "The harness does not support a capability this turn required.",
  },
  ROUTEKIT_EVAL_HARNESS_PROCESS_FAILED: {
    kind: "unavailable",
    retryable: true,
    summary: "The harness process stopped before the turn completed.",
  },
  ROUTEKIT_EVAL_HARNESS_PROTOCOL_FAILED: {
    kind: "protocol",
    retryable: false,
    summary: "The harness emitted invalid protocol data.",
  },
  ROUTEKIT_EVAL_HARNESS_VALIDATION_FAILED: {
    kind: "invalid-input",
    retryable: false,
    summary: "The harness configuration is invalid.",
  },
  ROUTEKIT_EVAL_LEGACY_RUNTIME_DIAGNOSTIC: {
    kind: "unknown",
    summary:
      "A prior ROUTEKIT_EVAL version recorded this mid-run diagnostic as free text.",
  },
  ROUTEKIT_EVAL_LEGACY_SCHEDULE_FIRE_FAILED: {
    kind: "unknown",
    summary: "A prior ROUTEKIT_EVAL version recorded this schedule failure as free text.",
  },
  ROUTEKIT_EVAL_LEGACY_TURN_FAILED: {
    kind: "unknown",
    summary: "A prior ROUTEKIT_EVAL version recorded this failure as free text.",
  },
  ROUTEKIT_EVAL_BEARER_TOKEN_MISSING: {
    kind: "configuration",
    retryable: false,
    summary: "No Gateway API key is configured.",
  },
  ROUTEKIT_EVAL_GATEWAY_CREDITS_EXHAUSTED: {
    kind: "upstream",
    retryable: false,
    summary: "The Gateway account cannot afford the request.",
  },
  ROUTEKIT_EVAL_PI_BINARY_UNAVAILABLE: {
    kind: "configuration",
    retryable: false,
    summary: "The Pi binary is missing or not executable.",
  },
  ROUTEKIT_EVAL_PI_COMPACTION_FAILED: {
    kind: "internal",
    summary: "Pi could not compact the session.",
  },
  ROUTEKIT_EVAL_PI_PROCESS_FAILED: {
    kind: "unavailable",
    retryable: true,
    summary: "The Pi process exited before completing the request.",
  },
  ROUTEKIT_EVAL_PI_PROCESS_TIMEOUT: {
    kind: "timeout",
    retryable: true,
    summary: "The Pi process exceeded its time budget.",
  },
  ROUTEKIT_EVAL_PI_PROVIDER_ERROR: {
    kind: "upstream",
    summary: "Pi's provider rejected the request.",
  },
  ROUTEKIT_EVAL_REQUEST_CANCELLED: {
    kind: "cancelled",
    retryable: false,
    summary: "The request was cancelled before it completed.",
  },
  ROUTEKIT_EVAL_RUNTIME_ENVIRONMENT_FAILED: {
    kind: "configuration",
    retryable: false,
    summary: "ROUTEKIT_EVAL could not prepare the harness environment.",
  },
  ROUTEKIT_EVAL_RUNTIME_INVOKE_FAILED: {
    kind: "internal",
    summary: "ROUTEKIT_EVAL could not complete the agent invocation.",
  },
  ROUTEKIT_EVAL_RUNTIME_SECRET_FAILED: {
    kind: "configuration",
    retryable: false,
    summary: "ROUTEKIT_EVAL could not resolve a required harness secret.",
  },
  ROUTEKIT_EVAL_RUNTIME_STREAM_SEVERED: {
    kind: "unavailable",
    retryable: true,
    summary: "The runtime event stream ended before a terminal event.",
  },
  ROUTEKIT_EVAL_RUNTIME_VALIDATION_FAILED: {
    kind: "internal",
    retryable: false,
    summary: "ROUTEKIT_EVAL produced a runtime event that failed validation.",
  },
  ROUTEKIT_EVAL_SCHEDULE_FIRE_FAILED: {
    kind: "internal",
    summary: "A scheduled run failed.",
  },
  ROUTEKIT_EVAL_SESSION_NOT_FOUND: {
    kind: "not-found",
    retryable: false,
    summary: "The requested session does not exist.",
  },
  ROUTEKIT_EVAL_SLACK_AGENT_STREAM_FAILED: {
    kind: "internal",
    retryable: true,
    summary: "The agent stream ended before Slack received a final result.",
  },
} as const satisfies Record<AgentFailureCode, AgentFailureCodeSpec>;

export const isAgentFailureCode = (value: string): value is AgentFailureCode =>
  Object.hasOwn(AGENT_FAILURE_CODES, value);
