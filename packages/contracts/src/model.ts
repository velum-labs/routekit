import type { JsonValue } from "./jcs.js";

export type CapabilityStatus = "supported" | "unsupported" | "degraded" | "unknown";

/**
 * OpenRouter-compatible model architecture metadata.
 *
 * Values deliberately remain open strings so newly advertised modalities do
 * not require a RouteKit release. The wire representation uses OpenRouter's
 * snake_case field names; internal TypeScript contracts use camelCase.
 *
 * Schema source: https://openrouter.ai/openapi.json
 */
export type ModelArchitecture = {
  modality?: string | null;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
};

export type ModelCapabilityMetadata = {
  architecture?: ModelArchitecture;
  supportedParameters?: readonly string[];
  provenance: "provider" | "route" | "openrouter-live";
};

/**
 * Provider-advertised signals used only to rank implicit model fallbacks.
 *
 * These are deliberately separate from capability metadata: creation time
 * and provider preference describe selection, not what a model can do.
 */
export type ModelSelectionSignals = {
  /** Provider-advertised Unix creation timestamp in seconds. */
  createdAt?: number;
  /** Provider-authored preference rank. Lower values are preferred. */
  providerPriority?: number;
};

export type ModelCallStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "requires_action"
  | "skipped"
  | "unsupported";

export type ModelCallSideEffects =
  | "none"
  | "read_only"
  | "writes_workspace"
  | "network"
  | "tool_execution"
  | "unknown";

export type ModelChatRole = "system" | "user" | "assistant" | "tool";

export type ModelChatMessage = {
  role: ModelChatRole;
  content: string;
};

export type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type RequestBillingMode = "api_key" | "subscription" | "client_auth";

/** Live and durable account selection state shared across status surfaces. */
export type AccountActivityState = {
  /** At least one upstream inference response body is still live. */
  serving: boolean;
  /** Number of live upstream inference attempts using this account. */
  inFlight: number;
  /** Wall-clock milliseconds when this account was most recently attempted. */
  lastSelectedAt?: number;
  /** Most recent selection globally, with coordinator sequence tie-breaking. */
  lastSelected: boolean;
};

/** Stable, machine-readable reasons an account cannot accept routing work. */
export type AccountReadinessReason =
  | { code: "catalog_empty" }
  | { code: "model_unavailable"; model: string }
  | { code: "cooldown_active"; until: number }
  | { code: "credential_invalid" }
  | { code: "credential_expired"; expiresAt: number }
  | { code: "provider_auth_refreshing" }
  | { code: "provider_auth_backoff"; until: number }
  | { code: "provider_auth_rejected"; status: 401 | 403 }
  | { code: "provider_quota_rejected"; window: string; status: string }
  | { code: "provider_quota_exceeded"; window: string; status: string }
  | {
      code: "quota_switch_threshold";
      window: string;
      utilization: number;
      switchThreshold: number;
    };

export type UpstreamAuthState = "unknown" | "accepted" | "refreshing" | "backoff" | "rejected";

/** Independent readiness dimensions; none imply current request activity. */
export type AccountReadinessState = {
  credentialValid?: boolean;
  upstreamAuthState?: UpstreamAuthState;
  poolEligible?: boolean;
  relayReady?: boolean;
  /** Absent on snapshots produced before readiness diagnostics were added. */
  readinessReasons?: AccountReadinessReason[];
};

export type CompositionalRoutingAttribution = {
  version: 2;
  mode: "shadow" | "active";
  definition_set_digest: string;
  evidence_digest: string;
  weights: ReadonlyArray<{ area_id: string; weight: number }>;
  unknown_weight: number;
  requirements: {
    endpoint: "chat" | "responses" | "anthropic";
    requires_tools: boolean;
    requires_vision: boolean;
    input_tokens?: number;
    max_output_tokens?: number;
  };
  objective:
    | { kind: "highest-quality" }
    | { kind: "lowest-cost"; minimum_quality: number }
    | { kind: "lowest-latency"; minimum_quality: number }
    | {
        kind: "balanced";
        minimum_quality: number;
        weights: { quality: number; cost: number; latency: number };
      }
    | {
        kind: "pareto";
        minimum_quality: number;
        preference: "quality" | "cost" | "latency";
      };
  candidates: ReadonlyArray<{
    model: string;
    eligible: boolean;
    exclusion_reasons: ReadonlyArray<string>;
    quality?: number;
    failure_rate?: number;
    p95_duration_ms?: number;
    average_cost_usd?: number;
    cost_status: "known" | "unavailable";
    utility?: number;
    rank?: number;
  }>;
  selected_model: string;
  fallback_models: ReadonlyArray<string>;
  classifier_call_id?: string;
};

/**
 * Sanitized, per-request routing attribution. This intentionally contains no
 * credentials, request headers, filesystem paths, or provider response text.
 */
export type RequestAttribution = {
  effective_model: string;
  native_model?: string;
  provider: string;
  billing_mode: RequestBillingMode;
  account?: {
    /** Process-local opaque reference; never a provider account id or label. */
    seat: string;
  };
  /**
   * Data-plane caller identity from a named token. Unlike `account.seat`,
   * `label` is intentionally human-readable for multi-user gateways.
   */
  principal?: {
    token_id: string;
    label?: string;
  };
  /** Sanitized decision evidence when the client requested model "auto". */
  auto_routing?: {
    profile_id: string;
    selected_model: string;
    evidence_digest: string;
    scores: ReadonlyArray<{ profile_id: string; probability: number }>;
  };
  /** Reproducible v2 area decomposition and deterministic scoring evidence. */
  compositional_routing?: CompositionalRoutingAttribution;
  eval?: {
    purpose: "eval";
    role: "author" | "candidate" | "judge";
    run_id: string;
    case_id?: string;
    policy_bypass: true;
  };
  attempts: number;
  retries: number;
  account_failovers: number;
};

export type ProviderErrorKind =
  | "none"
  | "provider_error"
  | "validation_error"
  | "timeout"
  | "rate_limited"
  | "capability_missing"
  | "internal_error";

export type ProviderError = {
  kind: ProviderErrorKind;
  message?: string;
  retryable?: boolean;
};

export type ProviderFailureCategory =
  | "transient"
  | "quota_exhausted"
  | "auth_permanent"
  | "auth_transient"
  | "context_overflow"
  | "unknown";

export type ProviderFailure = {
  category: ProviderFailureCategory;
  message: string;
  status?: number;
  retryAfter?: number;
  resetsAt?: number;
  provider?: string;
};

export class ProviderFailureError extends Error {
  readonly failure: ProviderFailure;

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderFailureError";
    this.failure = failure;
  }
}

export function isRetryableProviderFailure(category: ProviderFailureCategory): boolean {
  switch (category) {
    case "transient":
    case "quota_exhausted":
      return true;
    case "auth_transient":
    case "auth_permanent":
    case "context_overflow":
    case "unknown":
      return false;
    default: {
      const unreachable: never = category;
      throw new Error(`unhandled provider failure category: ${String(unreachable)}`);
    }
  }
}

/** Parse an HTTP Retry-After value into non-negative seconds. */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  now: () => number = Date.now
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const date = Date.parse(normalized);
  return Number.isFinite(date) ? Math.max(0, (date - now()) / 1000) : undefined;
}

export function classifyProviderFailure(
  status: number | undefined,
  message: string,
  options: {
    provider?: string;
    retryAfter?: number;
    resetsAt?: number;
    category?: ProviderFailureCategory;
  } = {}
): ProviderFailure {
  const category =
    options.category ??
    (status === 401 || status === 403
      ? "auth_permanent"
      : status === 408 || status === 429 || (status !== undefined && status >= 500)
        ? "transient"
        : /context|token limit|too long/i.test(message)
          ? "context_overflow"
          : "unknown");
  return {
    category,
    message,
    ...(status !== undefined ? { status } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.retryAfter !== undefined ? { retryAfter: options.retryAfter } : {}),
    ...(options.resetsAt !== undefined ? { resetsAt: options.resetsAt } : {})
  };
}

/**
 * Namespace applied to every model id advertised on RouteKit's `/v1/cursor`
 * surface. Cursor selects the BYOK provider by a case-sensitive prefix on the
 * model name (`claude-*` → Anthropic key, `gemini-*` → Google key, otherwise
 * OpenAI key + base-URL override). Prefixing every served id under this
 * namespace guarantees the advertised name can never trip those prefixes.
 */
export const CURSOR_MODEL_NAMESPACE = "routekit";

/**
 * Spell a served model id the way `/v1/cursor` advertises it to Cursor BYOK.
 * Always `routekit/<id>`; never conditional.
 */
export function cursorModelName(id: string): string {
  return `${CURSOR_MODEL_NAMESPACE}/${id}`;
}

/**
 * Strip the Cursor-facing `routekit/` namespace, returning the served id when
 * present. Returns `undefined` when the name is not namespaced.
 */
export function stripCursorNamespace(name: string): string | undefined {
  const prefix = `${CURSOR_MODEL_NAMESPACE}/`;
  if (!name.startsWith(prefix)) return undefined;
  const stripped = name.slice(prefix.length);
  return stripped.length > 0 ? stripped : undefined;
}

export type ModelEndpoint = {
  endpointId: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  capabilities?: Readonly<Record<string, CapabilityStatus>>;
};

export type ModelCallContract<E extends { kind: string } = ProviderError> = {
  call_id: string;
  endpoint_id: string;
  provider_request_id?: string;
  model: string;
  request_hash: string;
  response_hash?: string;
  messages: ModelChatMessage[];
  status: ModelCallStatus;
  side_effects: ModelCallSideEffects;
  started_at: string;
  finished_at?: string;
  latency_ms?: number;
  usage?: ModelUsage;
  output_text?: string;
  error?: E;
  metadata?: Record<string, JsonValue>;
};
