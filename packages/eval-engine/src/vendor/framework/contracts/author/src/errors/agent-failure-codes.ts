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
 * The closed index of ORI failure codes.
 *
 * A code is the stable key a human greps for, so it lives here rather than at
 * its throw site: adding one is a deliberate edit to a reviewed list, and a
 * typo is a type error.
 */
export const AGENT_FAILURE_CODE_LIST = [
  "ORI_ADAPTER_CAPACITY",
  "ORI_ADAPTER_CLOSED",
  "ORI_ADAPTER_CONFIG",
  "ORI_ADAPTER_CONNECTION",
  "ORI_ADAPTER_INITIALIZATION",
  "ORI_ADAPTER_INVALID_STATE",
  "ORI_ADAPTER_MALFORMED_INPUT",
  "ORI_ADAPTER_PEER_EXIT",
  "ORI_ADAPTER_PROTOCOL",
  "ORI_ADAPTER_PROTOCOL_VERSION",
  "ORI_ADAPTER_REMOTE_ERROR",
  "ORI_ADAPTER_RETRY_FAILED",
  "ORI_ADAPTER_TRANSPORT",
  "ORI_ADAPTER_UNAUTHORIZED",
  "ORI_CLAUDE_BINARY_UNAVAILABLE",
  "ORI_CLAUDE_NO_RESULT_EVENT",
  "ORI_CLAUDE_PLUGIN_INSTALL_FAILED",
  "ORI_CLAUDE_PROCESS_FAILED",
  "ORI_CLAUDE_PROCESS_TIMEOUT",
  "ORI_CLAUDE_RUNTIME_ERROR",
  "ORI_CLAUDE_SESSION_FAILED",
  "ORI_CLAUDE_TURN_LIMIT",
  "ORI_COMPACTION_FAILED",
  "ORI_COMPACTION_SUMMARY_FAILED",
  "ORI_CONTEXT_OVERFLOW",
  "ORI_HARNESS_CAPABILITY_UNSUPPORTED",
  "ORI_HARNESS_PROCESS_FAILED",
  "ORI_HARNESS_PROTOCOL_FAILED",
  "ORI_HARNESS_VALIDATION_FAILED",
  "ORI_LEGACY_RUNTIME_DIAGNOSTIC",
  "ORI_LEGACY_SCHEDULE_FIRE_FAILED",
  "ORI_LEGACY_TURN_FAILED",
  "ORI_OPENROUTER_API_KEY_MISSING",
  "ORI_OPENROUTER_CREDITS_EXHAUSTED",
  "ORI_PI_BINARY_UNAVAILABLE",
  "ORI_PI_COMPACTION_FAILED",
  "ORI_PI_PROCESS_FAILED",
  "ORI_PI_PROCESS_TIMEOUT",
  "ORI_PI_PROVIDER_ERROR",
  "ORI_REQUEST_CANCELLED",
  "ORI_RUNTIME_ENVIRONMENT_FAILED",
  "ORI_RUNTIME_INVOKE_FAILED",
  "ORI_RUNTIME_SECRET_FAILED",
  "ORI_RUNTIME_STREAM_SEVERED",
  "ORI_RUNTIME_VALIDATION_FAILED",
  "ORI_SCHEDULE_FIRE_FAILED",
  "ORI_SESSION_NOT_FOUND",
  "ORI_SLACK_AGENT_STREAM_FAILED",
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
  ORI_ADAPTER_CAPACITY: {
    kind: "unavailable",
    retryable: true,
    summary: "An adapter queue reached its capacity limit.",
  },
  ORI_ADAPTER_CLOSED: {
    kind: "unavailable",
    retryable: true,
    summary: "The adapter connection closed before the request finished.",
  },
  ORI_ADAPTER_CONFIG: {
    kind: "configuration",
    retryable: false,
    summary: "The adapter connection is misconfigured.",
  },
  ORI_ADAPTER_CONNECTION: {
    kind: "unavailable",
    retryable: true,
    summary: "The selected adapter connection failed.",
  },
  ORI_ADAPTER_INITIALIZATION: {
    kind: "protocol",
    retryable: false,
    summary: "The adapter peer failed to initialize.",
  },
  ORI_ADAPTER_INVALID_STATE: {
    kind: "internal",
    retryable: false,
    summary: "The selected adapter entered an invalid state.",
  },
  ORI_ADAPTER_MALFORMED_INPUT: {
    kind: "invalid-input",
    retryable: false,
    summary: "The selected adapter received invalid input.",
  },
  ORI_ADAPTER_PEER_EXIT: {
    kind: "unavailable",
    retryable: true,
    summary: "The adapter peer process exited before finishing the request.",
  },
  ORI_ADAPTER_PROTOCOL: {
    kind: "protocol",
    retryable: false,
    summary: "The adapter peer violated the ACP protocol.",
  },
  ORI_ADAPTER_PROTOCOL_VERSION: {
    kind: "protocol",
    retryable: false,
    summary: "The adapter peer speaks an unsupported ACP protocol version.",
  },
  ORI_ADAPTER_REMOTE_ERROR: {
    kind: "upstream",
    summary: "The adapter peer rejected the request.",
  },
  ORI_ADAPTER_RETRY_FAILED: {
    kind: "upstream",
    retryable: false,
    summary: "The adapter exhausted its retry attempts.",
  },
  ORI_ADAPTER_TRANSPORT: {
    kind: "unavailable",
    retryable: true,
    summary: "The adapter transport failed mid-request.",
  },
  ORI_ADAPTER_UNAUTHORIZED: {
    kind: "configuration",
    retryable: false,
    summary: "The upstream provider rejected the configured credential.",
  },
  ORI_CLAUDE_BINARY_UNAVAILABLE: {
    kind: "configuration",
    retryable: false,
    summary: "The Claude binary is missing or not executable.",
  },
  ORI_CLAUDE_NO_RESULT_EVENT: {
    kind: "protocol",
    retryable: true,
    summary: "Claude exited without emitting a result event.",
  },
  ORI_CLAUDE_PLUGIN_INSTALL_FAILED: {
    kind: "configuration",
    retryable: false,
    summary: "Claude could not install a required plugin.",
  },
  ORI_CLAUDE_PROCESS_FAILED: {
    kind: "unavailable",
    retryable: true,
    summary: "The Claude process exited before completing the request.",
  },
  ORI_CLAUDE_PROCESS_TIMEOUT: {
    kind: "timeout",
    retryable: true,
    summary: "The Claude process exceeded its time budget.",
  },
  ORI_CLAUDE_RUNTIME_ERROR: {
    kind: "upstream",
    summary: "Claude reported a runtime error mid-turn.",
  },
  ORI_CLAUDE_SESSION_FAILED: {
    kind: "upstream",
    summary: "Claude ended the session with an error result.",
  },
  ORI_CLAUDE_TURN_LIMIT: {
    kind: "configuration",
    retryable: false,
    summary: "Claude stopped after reaching the configured turn limit.",
  },
  ORI_COMPACTION_FAILED: {
    kind: "internal",
    summary: "Context compaction failed.",
  },
  ORI_COMPACTION_SUMMARY_FAILED: {
    kind: "internal",
    // The rollover always falls back to the journal projection, so the only
    // producer of this code retries by construction.
    retryable: true,
    summary: "ORI could not summarize the transcript for compaction.",
  },
  ORI_CONTEXT_OVERFLOW: {
    kind: "upstream",
    // Without a remediation this loses the rank tiebreak to any generic
    // upstream rejection that carries one, and a surface keying off the code
    // (Slack's `context-overflow`) reports the vaguer failure instead.
    remediation:
      "Compact or start a new session, or lower the request's output cap.",
    retryable: true,
    summary: "The request exceeds the model context window.",
  },
  ORI_HARNESS_CAPABILITY_UNSUPPORTED: {
    kind: "invalid-input",
    retryable: false,
    summary: "The harness does not support a capability this turn required.",
  },
  ORI_HARNESS_PROCESS_FAILED: {
    kind: "unavailable",
    retryable: true,
    summary: "The harness process stopped before the turn completed.",
  },
  ORI_HARNESS_PROTOCOL_FAILED: {
    kind: "protocol",
    retryable: false,
    summary: "The harness emitted invalid protocol data.",
  },
  ORI_HARNESS_VALIDATION_FAILED: {
    kind: "invalid-input",
    retryable: false,
    summary: "The harness configuration is invalid.",
  },
  ORI_LEGACY_RUNTIME_DIAGNOSTIC: {
    kind: "unknown",
    summary:
      "A prior ORI version recorded this mid-run diagnostic as free text.",
  },
  ORI_LEGACY_SCHEDULE_FIRE_FAILED: {
    kind: "unknown",
    summary: "A prior ORI version recorded this schedule failure as free text.",
  },
  ORI_LEGACY_TURN_FAILED: {
    kind: "unknown",
    summary: "A prior ORI version recorded this failure as free text.",
  },
  ORI_OPENROUTER_API_KEY_MISSING: {
    kind: "configuration",
    retryable: false,
    summary: "No OpenRouter API key is configured.",
  },
  ORI_OPENROUTER_CREDITS_EXHAUSTED: {
    kind: "upstream",
    retryable: false,
    summary: "The OpenRouter account cannot afford the request.",
  },
  ORI_PI_BINARY_UNAVAILABLE: {
    kind: "configuration",
    retryable: false,
    summary: "The Pi binary is missing or not executable.",
  },
  ORI_PI_COMPACTION_FAILED: {
    kind: "internal",
    summary: "Pi could not compact the session.",
  },
  ORI_PI_PROCESS_FAILED: {
    kind: "unavailable",
    retryable: true,
    summary: "The Pi process exited before completing the request.",
  },
  ORI_PI_PROCESS_TIMEOUT: {
    kind: "timeout",
    retryable: true,
    summary: "The Pi process exceeded its time budget.",
  },
  ORI_PI_PROVIDER_ERROR: {
    kind: "upstream",
    summary: "Pi's provider rejected the request.",
  },
  ORI_REQUEST_CANCELLED: {
    kind: "cancelled",
    retryable: false,
    summary: "The request was cancelled before it completed.",
  },
  ORI_RUNTIME_ENVIRONMENT_FAILED: {
    kind: "configuration",
    retryable: false,
    summary: "ORI could not prepare the harness environment.",
  },
  ORI_RUNTIME_INVOKE_FAILED: {
    kind: "internal",
    summary: "ORI could not complete the agent invocation.",
  },
  ORI_RUNTIME_SECRET_FAILED: {
    kind: "configuration",
    retryable: false,
    summary: "ORI could not resolve a required harness secret.",
  },
  ORI_RUNTIME_STREAM_SEVERED: {
    kind: "unavailable",
    retryable: true,
    summary: "The runtime event stream ended before a terminal event.",
  },
  ORI_RUNTIME_VALIDATION_FAILED: {
    kind: "internal",
    retryable: false,
    summary: "ORI produced a runtime event that failed validation.",
  },
  ORI_SCHEDULE_FIRE_FAILED: {
    kind: "internal",
    summary: "A scheduled run failed.",
  },
  ORI_SESSION_NOT_FOUND: {
    kind: "not-found",
    retryable: false,
    summary: "The requested session does not exist.",
  },
  ORI_SLACK_AGENT_STREAM_FAILED: {
    kind: "internal",
    retryable: true,
    summary: "The agent stream ended before Slack received a final result.",
  },
} as const satisfies Record<AgentFailureCode, AgentFailureCodeSpec>;

export const isAgentFailureCode = (value: string): value is AgentFailureCode =>
  Object.hasOwn(AGENT_FAILURE_CODES, value);
