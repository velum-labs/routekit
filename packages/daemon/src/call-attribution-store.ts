import type { RouteKitCallInspection } from "@velum-labs/routekit-control";
import type { ModelCallRecord, ProvenanceSink } from "@velum-labs/routekit-gateway";

export const DEFAULT_CALL_ATTRIBUTION_LIMIT = 1_000;
export const DEFAULT_CALL_ATTRIBUTION_TTL_MS = 24 * 60 * 60 * 1_000;

type StoredInspection = {
  inspection: RouteKitCallInspection;
  insertedAt: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boolean(value: unknown): boolean {
  return value === true;
}

export function callInspection(modelCall: ModelCallRecord): RouteKitCallInspection | undefined {
  const metadata = modelCall.metadata;
  const attribution = record(metadata?.attribution);
  const effectiveModel = string(attribution?.effective_model);
  const provider = string(attribution?.provider);
  const billingMode = string(attribution?.billing_mode);
  if (
    effectiveModel === undefined ||
    provider === undefined ||
    (billingMode !== "api_key" && billingMode !== "subscription" && billingMode !== "client_auth")
  ) {
    return undefined;
  }
  const account = record(attribution?.account);
  const accountSeat = string(account?.seat);
  const principal = record(attribution?.principal);
  const principalTokenId = string(principal?.token_id);
  const principalLabel = string(principal?.label);
  const nativeModel = string(attribution?.native_model);
  const estimateUsd = number(metadata?.cost_estimate_usd);
  const providerUsd = number(metadata?.provider_cost_usd);
  const currency = string(metadata?.cost_currency);
  const source =
    metadata?.cost_source === "provider" ||
    metadata?.cost_source === "estimate" ||
    metadata?.cost_source === "unknown"
      ? metadata.cost_source
      : undefined;
  const partialUsage = boolean(metadata?.partial_usage);
  const attempts = number(attribution?.attempts) ?? 1;
  const retries = number(attribution?.retries) ?? Math.max(0, attempts - 1);
  const accountFailovers = number(attribution?.account_failovers) ?? 0;
  return {
    callId: modelCall.call_id,
    status: modelCall.status,
    effectiveModel,
    ...(nativeModel !== undefined ? { nativeModel } : {}),
    provider,
    billingMode,
    ...(accountSeat !== undefined ? { account: { seat: accountSeat } } : {}),
    ...(principalTokenId !== undefined
      ? {
          principal: {
            tokenId: principalTokenId,
            ...(principalLabel !== undefined ? { label: principalLabel } : {})
          }
        }
      : {}),
    retries: {
      attempts,
      total: retries,
      accountFailovers
    },
    ...(modelCall.usage !== undefined ? { usage: modelCall.usage } : {}),
    cost: {
      ...(estimateUsd !== undefined ? { estimateUsd } : {}),
      ...(providerUsd !== undefined ? { providerUsd } : {}),
      ...(source !== undefined && source !== "unknown" ? { source } : {}),
      ...(currency !== undefined && source !== "unknown" ? { currency } : {}),
      ...(partialUsage ? { partialUsage } : {}),
      unknownUsage: boolean(metadata?.unknown_usage),
      unknownCost: boolean(metadata?.unknown_cost)
    },
    timing: {
      startedAt: modelCall.started_at,
      ...(modelCall.finished_at !== undefined ? { finishedAt: modelCall.finished_at } : {}),
      ...(modelCall.latency_ms !== undefined ? { latencyMs: modelCall.latency_ms } : {})
    },
    ...(modelCall.error !== undefined
      ? {
          error: {
            kind: modelCall.error.kind,
            ...(modelCall.error.retryable !== undefined
              ? { retryable: modelCall.error.retryable }
              : {})
          }
        }
      : {})
  };
}

/** Daemon-owned bounded index; intentionally does not persist across restarts. */
export class CallAttributionStore implements ProvenanceSink {
  readonly #entries = new Map<string, StoredInspection>();
  #limit: number;
  #ttlMs: number;
  readonly #now: () => number;
  #evicted = false;

  constructor(
    options: {
      limit?: number;
      ttlMs?: number;
      now?: () => number;
    } = {}
  ) {
    this.#limit = options.limit ?? DEFAULT_CALL_ATTRIBUTION_LIMIT;
    this.#ttlMs = options.ttlMs ?? DEFAULT_CALL_ATTRIBUTION_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  configureBudget(options: { limit: number; ttlMs: number }): void {
    this.#limit = options.limit;
    this.#ttlMs = options.ttlMs;
    this.#prune(this.#now());
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
      this.#evicted = true;
    }
  }

  budget(): { limit: number; ttlMs: number } {
    return { limit: this.#limit, ttlMs: this.#ttlMs };
  }

  onModelCall(modelCall: ModelCallRecord): void {
    const inspection = callInspection(modelCall);
    if (inspection === undefined) return;
    const now = this.#now();
    this.#prune(now);
    this.#entries.delete(inspection.callId);
    this.#entries.set(inspection.callId, { inspection, insertedAt: now });
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
      this.#evicted = true;
    }
  }

  get(callId: string): RouteKitCallInspection | undefined {
    this.#prune(this.#now());
    return this.#entries.get(callId)?.inspection;
  }

  /** Snapshot retained inspections after TTL prune (insertion order). */
  list(): RouteKitCallInspection[] {
    this.#prune(this.#now());
    return [...this.#entries.values()].map((entry) => entry.inspection);
  }

  /** True when the store has dropped records due to the capacity budget. */
  truncated(): boolean {
    return this.#evicted;
  }

  size(): number {
    this.#prune(this.#now());
    return this.#entries.size;
  }

  #prune(now: number): void {
    for (const [callId, entry] of this.#entries) {
      if (now - entry.insertedAt <= this.#ttlMs) break;
      this.#entries.delete(callId);
    }
  }
}
