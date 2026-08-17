import type {
  RouteKitCallInspection,
  RouteKitCompositionalRoutingInspection
} from "@velum-labs/routekit-control";
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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(string);
  return values.every((entry) => entry !== undefined) ? (values as string[]) : undefined;
}

function compositionalRoutingInspection(
  value: unknown
): RouteKitCompositionalRoutingInspection | undefined {
  const routing = record(value);
  if (routing?.version !== 2 || (routing.mode !== "shadow" && routing.mode !== "active")) {
    return undefined;
  }
  const definitionSetDigest = string(routing.definition_set_digest);
  const evidenceDigest = string(routing.evidence_digest);
  const unknownWeight = number(routing.unknown_weight);
  const selectedModel = string(routing.selected_model);
  const fallbackModels = stringArray(routing.fallback_models);
  const inferenceCallId = string(routing.inference_call_id);
  const classifierCallId = string(routing.classifier_call_id);
  const weights = Array.isArray(routing.weights)
    ? routing.weights.flatMap((value) => {
        const weight = record(value);
        const areaId = string(weight?.area_id);
        const amount = number(weight?.weight);
        return areaId === undefined || amount === undefined ? [] : [{ areaId, weight: amount }];
      })
    : [];
  const requirements = record(routing.requirements);
  const endpoint = string(requirements?.endpoint);
  const inputTokens = number(requirements?.input_tokens);
  const maxOutputTokens = number(requirements?.max_output_tokens);
  const objective = compositionalObjective(routing.objective);
  const candidates = Array.isArray(routing.candidates)
    ? routing.candidates.flatMap((value) => {
        const candidate = record(value);
        const model = string(candidate?.model);
        const exclusionReasons = stringArray(candidate?.exclusion_reasons);
        const costStatus = string(candidate?.cost_status);
        if (
          model === undefined ||
          exclusionReasons === undefined ||
          (costStatus !== "known" && costStatus !== "unavailable") ||
          typeof candidate?.eligible !== "boolean"
        ) {
          return [];
        }
        return [
          {
            model,
            eligible: candidate.eligible,
            exclusionReasons,
            ...(number(candidate.quality) === undefined
              ? {}
              : { quality: number(candidate.quality) }),
            ...(number(candidate.failure_rate) === undefined
              ? {}
              : { failureRate: number(candidate.failure_rate) }),
            ...(number(candidate.p95_duration_ms) === undefined
              ? {}
              : { p95DurationMs: number(candidate.p95_duration_ms) }),
            ...(number(candidate.average_cost_usd) === undefined
              ? {}
              : { averageCostUsd: number(candidate.average_cost_usd) }),
            costStatus: costStatus as "known" | "unavailable",
            ...(typeof candidate.utility !== "number" || !Number.isFinite(candidate.utility)
              ? {}
              : { utility: candidate.utility }),
            ...(number(candidate.rank) === undefined ? {} : { rank: number(candidate.rank) })
          }
        ];
      })
    : [];
  if (
    definitionSetDigest === undefined ||
    evidenceDigest === undefined ||
    unknownWeight === undefined ||
    selectedModel === undefined ||
    fallbackModels === undefined ||
    inferenceCallId === undefined ||
    weights.length === 0 ||
    weights.length !== (Array.isArray(routing.weights) ? routing.weights.length : 0) ||
    requirements === undefined ||
    (endpoint !== "chat" && endpoint !== "responses" && endpoint !== "anthropic") ||
    typeof requirements.requires_tools !== "boolean" ||
    typeof requirements.requires_vision !== "boolean" ||
    objective === undefined ||
    candidates.length === 0 ||
    candidates.length !== (Array.isArray(routing.candidates) ? routing.candidates.length : 0)
  ) {
    return undefined;
  }
  return {
    version: 2,
    mode: routing.mode,
    definitionSetDigest,
    evidenceDigest,
    weights,
    unknownWeight,
    requirements: {
      endpoint,
      requiresTools: requirements.requires_tools,
      requiresVision: requirements.requires_vision,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    },
    objective,
    candidates,
    selectedModel,
    fallbackModels,
    ...(classifierCallId === undefined ? {} : { classifierCallId }),
    inferenceCallId
  };
}

function compositionalObjective(
  value: unknown
): RouteKitCompositionalRoutingInspection["objective"] | undefined {
  const objective = record(value);
  const kind = string(objective?.kind);
  if (kind === "highest-quality") return { kind };
  const minimumQuality = number(objective?.minimum_quality);
  if (
    (kind === "lowest-cost" || kind === "lowest-latency") &&
    minimumQuality !== undefined
  ) {
    return { kind, minimumQuality };
  }
  if (kind === "balanced" && minimumQuality !== undefined) {
    const weights = record(objective?.weights);
    const quality = number(weights?.quality);
    const cost = number(weights?.cost);
    const latency = number(weights?.latency);
    if (quality !== undefined && cost !== undefined && latency !== undefined) {
      return { kind, minimumQuality, weights: { quality, cost, latency } };
    }
  }
  const preference = string(objective?.preference);
  if (
    kind === "pareto" &&
    minimumQuality !== undefined &&
    (preference === "quality" || preference === "cost" || preference === "latency")
  ) {
    return { kind, minimumQuality, preference };
  }
  return undefined;
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
  const requestedModel = string(metadata?.requested_model);
  const autoRouting = record(attribution?.auto_routing);
  const autoProfileId = string(autoRouting?.profile_id);
  const autoSelectedModel = string(autoRouting?.selected_model);
  const autoEvidenceDigest = string(autoRouting?.evidence_digest);
  const autoScores = Array.isArray(autoRouting?.scores)
    ? autoRouting.scores.flatMap((value) => {
        const score = record(value);
        const profileId = string(score?.profile_id);
        const probability = number(score?.probability);
        return profileId === undefined || probability === undefined
          ? []
          : [{ profileId, probability }];
      })
    : [];
  const compositionalRouting = compositionalRoutingInspection(
    attribution?.compositional_routing
  );
  const evalAttribution = record(attribution?.eval);
  const evalRole = string(evalAttribution?.role);
  const evalRunId = string(evalAttribution?.run_id);
  const evalCaseId = string(evalAttribution?.case_id);
  const estimateUsd = number(metadata?.cost_estimate_usd);
  const attempts = number(attribution?.attempts) ?? 1;
  const retries = number(attribution?.retries) ?? Math.max(0, attempts - 1);
  const accountFailovers = number(attribution?.account_failovers) ?? 0;
  return {
    callId: modelCall.call_id,
    status: modelCall.status,
    ...(requestedModel !== undefined ? { requestedModel } : {}),
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
    ...(compositionalRouting === undefined ? {} : { compositionalRouting }),
    ...(autoProfileId !== undefined &&
    autoSelectedModel !== undefined &&
    autoEvidenceDigest !== undefined &&
    autoScores.length > 0
      ? {
          autoRouting: {
            profileId: autoProfileId,
            selectedModel: autoSelectedModel,
            evidenceDigest: autoEvidenceDigest,
            scores: autoScores
          }
        }
      : {}),
    ...(evalRunId !== undefined &&
    (evalRole === "author" || evalRole === "candidate" || evalRole === "judge") &&
    evalAttribution?.policy_bypass === true
      ? {
          eval: {
            role: evalRole,
            runId: evalRunId,
            ...(evalCaseId === undefined ? {} : { caseId: evalCaseId }),
            policyBypass: true as const
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
