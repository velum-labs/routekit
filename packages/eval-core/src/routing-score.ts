import type {
  PublishedRoutingSnapshotV2,
  RequestAreaDecomposition,
  RequestRoutingRequirements,
  RoutingCandidateDecision,
  RoutingEndpoint,
  RoutingObjectivePolicy
} from "@velum-labs/routekit-eval-contracts";
import { ROUTING_AREA_VECTOR_TOLERANCE } from "@velum-labs/routekit-eval-contracts";

const VECTOR_TOLERANCE = ROUTING_AREA_VECTOR_TOLERANCE;

export type RoutingModelAvailability = Readonly<{
  model: string;
  served: boolean;
  endpoints: readonly RoutingEndpoint[];
  supportsTools: boolean;
  supportsVision: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}>;

export type RoutingScoreConstraints = Readonly<{
  /** Per-area conservative quality floors, applied before aggregation. */
  minimumAreaQuality?: Readonly<Record<string, number>>;
  /** Maximum weighted failure rate for a candidate. */
  maximumFailureRate?: number;
}>;

export type ScoreRoutingCandidatesInput = Readonly<{
  snapshot: PublishedRoutingSnapshotV2;
  decomposition: RequestAreaDecomposition;
  requirements: RequestRoutingRequirements;
  objective: RoutingObjectivePolicy;
  availableModels: readonly RoutingModelAvailability[];
  constraints?: RoutingScoreConstraints;
}>;

export type RoutingScoreResult = Readonly<{
  candidates: readonly RoutingCandidateDecision[];
  selectedModel: string;
  fallbackModels: readonly string[];
}>;

export type RoutingScoringErrorCode = "invalid_input" | "no_eligible_models";

export class RoutingScoringError extends Error {
  readonly code: RoutingScoringErrorCode;
  readonly candidates: readonly RoutingCandidateDecision[];

  constructor(
    code: RoutingScoringErrorCode,
    message: string,
    candidates: readonly RoutingCandidateDecision[] = []
  ) {
    super(message);
    this.name = "RoutingScoringError";
    this.code = code;
    this.candidates = candidates;
  }
}

type CalculatedCandidate = {
  model: string;
  reasons: string[];
  quality?: number;
  failureRate?: number;
  p95DurationMs?: number;
  averageCostUsd?: number;
  costStatus: "known" | "unavailable";
  utility?: number;
  rank?: number;
};

type WeightedArea = Readonly<{ areaId: string; weight: number }>;

function invalid(message: string): never {
  throw new RoutingScoringError("invalid_input", message);
}

function finiteUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${label} must be a finite number between zero and one`);
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must not contain duplicates`);
}

function compareModelIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumberAscending(left: number | undefined, right: number | undefined): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return left - right;
}

function compareNumberDescending(left: number | undefined, right: number | undefined): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return right - left;
}

function activeWeights(input: ScoreRoutingCandidatesInput): readonly WeightedArea[] {
  if (input.snapshot.definitionSetDigest !== input.decomposition.definitionSetDigest) {
    invalid("area definition digest does not match the routing snapshot");
  }

  const areaIds = input.snapshot.areas.map((area) => area.id);
  unique(areaIds, "snapshot area IDs");
  unique(input.snapshot.candidateModels, "snapshot candidate models");
  if (areaIds.length === 0) invalid("routing snapshot must contain at least one area");
  if (input.snapshot.candidateModels.length === 0) {
    invalid("routing snapshot must contain at least one candidate model");
  }

  const weights = new Map<string, number>();
  for (const entry of input.decomposition.weights) {
    finiteUnit(entry.weight, `weight for area ${entry.areaId}`);
    if (weights.has(entry.areaId)) invalid(`duplicate decomposition area: ${entry.areaId}`);
    if (!areaIds.includes(entry.areaId)) invalid(`unknown decomposition area: ${entry.areaId}`);
    weights.set(entry.areaId, entry.weight);
  }
  for (const areaId of areaIds) {
    if (!weights.has(areaId)) invalid(`missing decomposition area: ${areaId}`);
  }
  finiteUnit(input.decomposition.unknownWeight, "unknown weight");
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total + input.decomposition.unknownWeight - 1) > VECTOR_TOLERANCE) {
    invalid("area weights and unknown weight must sum to one");
  }
  if (total <= VECTOR_TOLERANCE) invalid("routing requires at least one covered area");

  return areaIds.flatMap((areaId): WeightedArea[] => {
    const weight = weights.get(areaId) ?? 0;
    return weight > VECTOR_TOLERANCE ? [{ areaId, weight: weight / total }] : [];
  });
}

function validateInput(input: ScoreRoutingCandidatesInput): readonly WeightedArea[] {
  const active = activeWeights(input);
  const availableIds = input.availableModels.map((model) => model.model);
  unique(availableIds, "available model IDs");

  const floors = input.constraints?.minimumAreaQuality ?? {};
  const knownAreas = new Set(input.snapshot.areas.map((area) => area.id));
  for (const [areaId, floor] of Object.entries(floors)) {
    if (!knownAreas.has(areaId)) invalid(`quality floor refers to unknown area: ${areaId}`);
    finiteUnit(floor, `quality floor for area ${areaId}`);
  }
  const maximumFailureRate = input.constraints?.maximumFailureRate;
  if (maximumFailureRate !== undefined) {
    finiteUnit(maximumFailureRate, "maximum failure rate");
  }

  switch (input.objective.kind) {
    case "highest-quality":
      break;
    case "lowest-cost":
    case "lowest-latency":
    case "pareto":
      finiteUnit(input.objective.minimumQuality, "minimum quality");
      break;
    case "balanced": {
      finiteUnit(input.objective.minimumQuality, "minimum quality");
      const { quality, cost, latency } = input.objective.weights;
      finiteUnit(quality, "balanced quality weight");
      finiteUnit(cost, "balanced cost weight");
      finiteUnit(latency, "balanced latency weight");
      if (Math.abs(quality + cost + latency - 1) > VECTOR_TOLERANCE) {
        invalid("balanced objective weights must sum to one");
      }
      break;
    }
    default: {
      const unreachable: never = input.objective;
      invalid(`unsupported routing objective: ${String(unreachable)}`);
    }
  }
  return active;
}

function capabilityReasons(
  availability: RoutingModelAvailability | undefined,
  requirements: RequestRoutingRequirements
): string[] {
  if (availability === undefined || !availability.served) return ["model_not_served"];
  const reasons: string[] = [];
  if (!availability.endpoints.includes(requirements.endpoint)) {
    reasons.push(`endpoint_not_supported:${requirements.endpoint}`);
  }
  if (requirements.requiresTools && !availability.supportsTools) {
    reasons.push("tools_not_supported");
  }
  if (requirements.requiresVision && !availability.supportsVision) {
    reasons.push("vision_not_supported");
  }
  if (
    requirements.inputTokens !== undefined &&
    (availability.maxInputTokens === undefined ||
      availability.maxInputTokens < requirements.inputTokens)
  ) {
    reasons.push("input_token_limit_insufficient");
  }
  if (
    requirements.maxOutputTokens !== undefined &&
    (availability.maxOutputTokens === undefined ||
      availability.maxOutputTokens < requirements.maxOutputTokens)
  ) {
    reasons.push("output_token_limit_insufficient");
  }
  return reasons;
}

function calculateCandidates(
  input: ScoreRoutingCandidatesInput,
  active: readonly WeightedArea[]
): CalculatedCandidate[] {
  const availability = new Map(input.availableModels.map((model) => [model.model, model]));
  const floors = input.constraints?.minimumAreaQuality ?? {};

  return input.snapshot.candidateModels.map((model): CalculatedCandidate => {
    const reasons = capabilityReasons(availability.get(model), input.requirements);
    let quality = 0;
    let failureRate = 0;
    let duration = 0;
    let cost = 0;
    let completeCoreEvidence = true;
    let completeDuration = true;
    let completeCost = true;

    for (const { areaId, weight } of active) {
      const cells = input.snapshot.evidence.filter(
        (cell) => cell.model === model && cell.areaId === areaId
      );
      if (cells.length === 0) {
        reasons.push(`missing_evidence:${areaId}`);
        completeCoreEvidence = false;
        completeDuration = false;
        completeCost = false;
        continue;
      }
      if (cells.length > 1) {
        reasons.push(`duplicate_evidence:${areaId}`);
        completeCoreEvidence = false;
        completeDuration = false;
        completeCost = false;
        continue;
      }
      const cell = cells[0];
      if (cell === undefined) continue;
      quality += cell.quality.lowerConfidenceBound * weight;
      failureRate += cell.failureRate * weight;
      const floor = floors[areaId];
      if (floor !== undefined && cell.quality.lowerConfidenceBound < floor) {
        reasons.push(`quality_below_area_floor:${areaId}`);
      }
      if (cell.p95DurationMs === undefined) completeDuration = false;
      else duration += cell.p95DurationMs * weight;
      if (cell.averageCostUsd === undefined || cell.unpricedCalls > 0) completeCost = false;
      else cost += cell.averageCostUsd * weight;
    }

    const candidate: CalculatedCandidate = {
      model,
      reasons,
      costStatus: completeCoreEvidence && completeCost ? "known" : "unavailable",
      ...(completeCoreEvidence ? { quality, failureRate } : {}),
      ...(completeCoreEvidence && completeDuration ? { p95DurationMs: duration } : {}),
      ...(completeCoreEvidence && completeCost ? { averageCostUsd: cost } : {})
    };

    if (
      candidate.failureRate !== undefined &&
      input.constraints?.maximumFailureRate !== undefined &&
      candidate.failureRate > input.constraints.maximumFailureRate
    ) {
      reasons.push("failure_rate_above_maximum");
    }
    return candidate;
  });
}

function applyObjectiveEligibility(
  candidates: CalculatedCandidate[],
  objective: RoutingObjectivePolicy
): void {
  for (const candidate of candidates) {
    const quality = candidate.quality;
    if (quality === undefined) continue;
    switch (objective.kind) {
      case "highest-quality":
        break;
      case "lowest-cost":
        if (quality < objective.minimumQuality) candidate.reasons.push("quality_below_minimum");
        if (candidate.averageCostUsd === undefined) candidate.reasons.push("cost_unavailable");
        break;
      case "lowest-latency":
        if (quality < objective.minimumQuality) candidate.reasons.push("quality_below_minimum");
        if (candidate.p95DurationMs === undefined) candidate.reasons.push("latency_unavailable");
        break;
      case "balanced":
        if (quality < objective.minimumQuality) candidate.reasons.push("quality_below_minimum");
        if (objective.weights.cost > 0 && candidate.averageCostUsd === undefined) {
          candidate.reasons.push("cost_unavailable");
        }
        if (objective.weights.latency > 0 && candidate.p95DurationMs === undefined) {
          candidate.reasons.push("latency_unavailable");
        }
        break;
      case "pareto":
        if (quality < objective.minimumQuality) candidate.reasons.push("quality_below_minimum");
        if (candidate.averageCostUsd === undefined) candidate.reasons.push("cost_unavailable");
        if (candidate.p95DurationMs === undefined) candidate.reasons.push("latency_unavailable");
        break;
      default: {
        const unreachable: never = objective;
        invalid(`unsupported routing objective: ${String(unreachable)}`);
      }
    }
  }
}

function normalizeHigher(value: number, minimum: number, maximum: number): number {
  return maximum === minimum ? 1 : (value - minimum) / (maximum - minimum);
}

function normalizeLower(value: number, minimum: number, maximum: number): number {
  return maximum === minimum ? 1 : (maximum - value) / (maximum - minimum);
}

function assignBalancedUtility(
  candidates: readonly CalculatedCandidate[],
  objective: Extract<RoutingObjectivePolicy, { kind: "balanced" }>
): void {
  const eligible = candidates.filter((candidate) => candidate.reasons.length === 0);
  const qualities = eligible.flatMap((candidate) =>
    candidate.quality === undefined ? [] : [candidate.quality]
  );
  const costs = eligible.flatMap((candidate) =>
    candidate.averageCostUsd === undefined ? [] : [candidate.averageCostUsd]
  );
  const latencies = eligible.flatMap((candidate) =>
    candidate.p95DurationMs === undefined ? [] : [candidate.p95DurationMs]
  );
  if (qualities.length === 0) return;
  const qualityMin = Math.min(...qualities);
  const qualityMax = Math.max(...qualities);
  const costMin = costs.length === 0 ? 0 : Math.min(...costs);
  const costMax = costs.length === 0 ? 0 : Math.max(...costs);
  const latencyMin = latencies.length === 0 ? 0 : Math.min(...latencies);
  const latencyMax = latencies.length === 0 ? 0 : Math.max(...latencies);

  for (const candidate of eligible) {
    const quality = candidate.quality;
    if (quality === undefined) continue;
    const qualityUtility = normalizeHigher(quality, qualityMin, qualityMax);
    const costUtility =
      objective.weights.cost === 0
        ? 0
        : normalizeLower(candidate.averageCostUsd ?? 0, costMin, costMax);
    const latencyUtility =
      objective.weights.latency === 0
        ? 0
        : normalizeLower(candidate.p95DurationMs ?? 0, latencyMin, latencyMax);
    candidate.utility =
      objective.weights.quality * qualityUtility +
      objective.weights.cost * costUtility +
      objective.weights.latency * latencyUtility;
  }
}

function standardComparator(
  objective: Exclude<RoutingObjectivePolicy, { kind: "pareto" }>
): (left: CalculatedCandidate, right: CalculatedCandidate) => number {
  return (left, right) => {
    let comparison = 0;
    switch (objective.kind) {
      case "highest-quality":
        comparison =
          compareNumberDescending(left.quality, right.quality) ||
          compareNumberAscending(left.failureRate, right.failureRate) ||
          compareNumberAscending(left.p95DurationMs, right.p95DurationMs) ||
          compareNumberAscending(left.averageCostUsd, right.averageCostUsd);
        break;
      case "lowest-cost":
        comparison =
          compareNumberAscending(left.averageCostUsd, right.averageCostUsd) ||
          compareNumberDescending(left.quality, right.quality) ||
          compareNumberAscending(left.failureRate, right.failureRate) ||
          compareNumberAscending(left.p95DurationMs, right.p95DurationMs);
        break;
      case "lowest-latency":
        comparison =
          compareNumberAscending(left.p95DurationMs, right.p95DurationMs) ||
          compareNumberDescending(left.quality, right.quality) ||
          compareNumberAscending(left.failureRate, right.failureRate) ||
          compareNumberAscending(left.averageCostUsd, right.averageCostUsd);
        break;
      case "balanced":
        comparison =
          compareNumberDescending(left.utility, right.utility) ||
          compareNumberDescending(left.quality, right.quality) ||
          compareNumberAscending(left.averageCostUsd, right.averageCostUsd) ||
          compareNumberAscending(left.p95DurationMs, right.p95DurationMs) ||
          compareNumberAscending(left.failureRate, right.failureRate);
        break;
      default: {
        const unreachable: never = objective;
        invalid(`unsupported routing objective: ${String(unreachable)}`);
      }
    }
    return comparison || compareModelIds(left.model, right.model);
  };
}

function dominates(left: CalculatedCandidate, right: CalculatedCandidate): boolean {
  const leftQuality = left.quality;
  const rightQuality = right.quality;
  const leftCost = left.averageCostUsd;
  const rightCost = right.averageCostUsd;
  const leftLatency = left.p95DurationMs;
  const rightLatency = right.p95DurationMs;
  if (
    leftQuality === undefined ||
    rightQuality === undefined ||
    leftCost === undefined ||
    rightCost === undefined ||
    leftLatency === undefined ||
    rightLatency === undefined
  ) {
    return false;
  }
  const noWorse =
    leftQuality >= rightQuality && leftCost <= rightCost && leftLatency <= rightLatency;
  const strictlyBetter =
    leftQuality > rightQuality || leftCost < rightCost || leftLatency < rightLatency;
  return noWorse && strictlyBetter;
}

function paretoPreferenceComparator(
  preference: "quality" | "cost" | "latency"
): (left: CalculatedCandidate, right: CalculatedCandidate) => number {
  return (left, right) => {
    const preferred =
      preference === "quality"
        ? compareNumberDescending(left.quality, right.quality)
        : preference === "cost"
          ? compareNumberAscending(left.averageCostUsd, right.averageCostUsd)
          : compareNumberAscending(left.p95DurationMs, right.p95DurationMs);
    return (
      preferred ||
      compareNumberDescending(left.quality, right.quality) ||
      compareNumberAscending(left.averageCostUsd, right.averageCostUsd) ||
      compareNumberAscending(left.p95DurationMs, right.p95DurationMs) ||
      compareNumberAscending(left.failureRate, right.failureRate) ||
      compareModelIds(left.model, right.model)
    );
  };
}

function paretoOrder(
  candidates: readonly CalculatedCandidate[],
  preference: "quality" | "cost" | "latency"
): CalculatedCandidate[] {
  const remaining = [...candidates];
  const ordered: CalculatedCandidate[] = [];
  const comparator = paretoPreferenceComparator(preference);
  while (remaining.length > 0) {
    const frontier = remaining.filter(
      (candidate) => !remaining.some((other) => other !== candidate && dominates(other, candidate))
    );
    frontier.sort(comparator);
    ordered.push(...frontier);
    const frontierModels = new Set(frontier.map((candidate) => candidate.model));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index];
      if (candidate !== undefined && frontierModels.has(candidate.model))
        remaining.splice(index, 1);
    }
  }
  return ordered;
}

function publicDecision(candidate: CalculatedCandidate): RoutingCandidateDecision {
  return {
    model: candidate.model,
    eligible: candidate.reasons.length === 0,
    exclusionReasons: candidate.reasons,
    costStatus: candidate.costStatus,
    ...(candidate.quality === undefined ? {} : { quality: candidate.quality }),
    ...(candidate.failureRate === undefined ? {} : { failureRate: candidate.failureRate }),
    ...(candidate.p95DurationMs === undefined ? {} : { p95DurationMs: candidate.p95DurationMs }),
    ...(candidate.averageCostUsd === undefined ? {} : { averageCostUsd: candidate.averageCostUsd }),
    ...(candidate.utility === undefined ? {} : { utility: candidate.utility }),
    ...(candidate.rank === undefined ? {} : { rank: candidate.rank })
  };
}

/**
 * Deterministically rank candidate models from a semantic decomposition and a
 * published model-by-area evidence matrix. This function performs no I/O and
 * never treats missing or partially unpriced cost as zero.
 */
export function scoreRoutingCandidates(input: ScoreRoutingCandidatesInput): RoutingScoreResult {
  const active = validateInput(input);
  const candidates = calculateCandidates(input, active);
  applyObjectiveEligibility(candidates, input.objective);
  if (input.objective.kind === "balanced") {
    assignBalancedUtility(candidates, input.objective);
  }

  const eligible = candidates.filter((candidate) => candidate.reasons.length === 0);
  const rejected = candidates
    .filter((candidate) => candidate.reasons.length > 0)
    .sort((left, right) => compareModelIds(left.model, right.model));
  const ranked =
    input.objective.kind === "pareto"
      ? paretoOrder(eligible, input.objective.preference)
      : [...eligible].sort(standardComparator(input.objective));
  ranked.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  const decisions = [...ranked, ...rejected].map(publicDecision);
  const selected = ranked[0];
  if (selected === undefined) {
    throw new RoutingScoringError(
      "no_eligible_models",
      "no candidate model satisfies the routing requirements and objective",
      decisions
    );
  }
  return {
    candidates: decisions,
    selectedModel: selected.model,
    fallbackModels: ranked.slice(1).map((candidate) => candidate.model)
  };
}
