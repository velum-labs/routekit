import { Schema } from "effect";

/** Header that marks an eval egress call so the auto-router must not apply. */
export const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";

/** Attribution metadata for candidate and judge calls. */
export const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";

export const EVAL_CONTRACT_VERSION = 1 as const;
export const COMPOSITIONAL_ROUTING_VERSION = 2 as const;
export const EVAL_SETUP_VERSION = 1 as const;
export const CLASSIFIER_BASIS_TEXT_LIMIT = 64 * 1_024;
export const ROUTING_BASIS_DIMENSION_MIN = 5;
export const ROUTING_BASIS_DIMENSION_MAX = 10;
export const WORKLOAD_DIMENSION_DESCRIPTION_LIMIT = 1_024;
export const WORKLOAD_DIMENSION_BOUNDARY_LIMIT = 512;
export const REQUEST_DECOMPOSITION_TOLERANCE = 1e-6;

export const EvalContractVersion = Schema.Literal(EVAL_CONTRACT_VERSION);
export type EvalContractVersion = typeof EvalContractVersion.Type;

const NonNegativeFinite = Schema.Finite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      value >= 0 ? undefined : "value must be greater than or equal to zero"
    )
  )
);
const NonNegativeInteger = NonNegativeFinite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      Number.isInteger(value) ? undefined : "value must be an integer"
    )
  )
);
const UnitInterval = Schema.Finite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      value >= 0 && value <= 1 ? undefined : "value must be between 0 and 1"
    )
  )
);

export const CompositionalRoutingVersion = Schema.Literal(COMPOSITIONAL_ROUTING_VERSION);
export type CompositionalRoutingVersion = typeof CompositionalRoutingVersion.Type;

export const WorkloadDimension = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  includes: Schema.Array(Schema.String),
  excludes: Schema.Array(Schema.String)
});
export type WorkloadDimension = typeof WorkloadDimension.Type;

export const RoutingBasis = Schema.Struct({
  version: CompositionalRoutingVersion,
  basisDigest: Schema.String,
  dimensions: Schema.Array(WorkloadDimension)
});
export type RoutingBasis = typeof RoutingBasis.Type;

export const DimensionWeight = Schema.Struct({
  dimensionId: Schema.String,
  weight: UnitInterval
});
export type DimensionWeight = typeof DimensionWeight.Type;

export const DecompositionInput = Schema.Struct({
  request: Schema.String,
  dimensions: Schema.Array(WorkloadDimension)
});
export type DecompositionInput = typeof DecompositionInput.Type;

export const DecompositionResult = Schema.Struct({
  weights: Schema.Array(DimensionWeight),
  unknownWeight: UnitInterval
});
export type DecompositionResult = typeof DecompositionResult.Type;

export const RequestDecomposition = Schema.Struct({
  version: CompositionalRoutingVersion,
  basisDigest: Schema.String,
  weights: Schema.Array(DimensionWeight),
  unknownWeight: UnitInterval
});
export type RequestDecomposition = typeof RequestDecomposition.Type;

export const RoutingEndpoint = Schema.Literals(["chat", "responses", "anthropic"]);
export type RoutingEndpoint = typeof RoutingEndpoint.Type;

export const RequestRoutingRequirements = Schema.Struct({
  endpoint: RoutingEndpoint,
  requiresTools: Schema.Boolean,
  requiresVision: Schema.Boolean,
  inputTokens: Schema.optionalKey(NonNegativeInteger),
  maxOutputTokens: Schema.optionalKey(NonNegativeInteger)
});
export type RequestRoutingRequirements = typeof RequestRoutingRequirements.Type;

export const ModelDimensionQuality = Schema.Struct({
  passRate: UnitInterval,
  lowerConfidenceBound: UnitInterval,
  sampleCount: NonNegativeInteger
});
export type ModelDimensionQuality = typeof ModelDimensionQuality.Type;

export const ModelDimensionEvidence = Schema.Struct({
  model: Schema.String,
  dimensionId: Schema.String,
  suiteDigest: Schema.String,
  evidenceDigest: Schema.String,
  quality: ModelDimensionQuality,
  failureRate: UnitInterval,
  averageJudgeScore: Schema.optionalKey(UnitInterval),
  p95DurationMs: Schema.optionalKey(NonNegativeFinite),
  averageCostUsd: Schema.optionalKey(NonNegativeFinite),
  unpricedCalls: NonNegativeInteger
});
export type ModelDimensionEvidence = typeof ModelDimensionEvidence.Type;

export const RoutingMetricWeights = Schema.Struct({
  quality: UnitInterval,
  cost: UnitInterval,
  latency: UnitInterval
});
export type RoutingMetricWeights = typeof RoutingMetricWeights.Type;

export const RoutingObjectivePolicy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("highest-quality")
  }),
  Schema.Struct({
    kind: Schema.Literal("lowest-cost"),
    minimumQuality: UnitInterval
  }),
  Schema.Struct({
    kind: Schema.Literal("lowest-latency"),
    minimumQuality: UnitInterval
  }),
  Schema.Struct({
    kind: Schema.Literal("balanced"),
    minimumQuality: UnitInterval,
    weights: RoutingMetricWeights
  }),
  Schema.Struct({
    kind: Schema.Literal("pareto"),
    minimumQuality: UnitInterval,
    preference: Schema.Literals(["quality", "cost", "latency"])
  })
]);
export type RoutingObjectivePolicy = typeof RoutingObjectivePolicy.Type;

export const RoutingCandidateDecision = Schema.Struct({
  model: Schema.String,
  eligible: Schema.Boolean,
  exclusionReasons: Schema.Array(Schema.String),
  quality: Schema.optionalKey(UnitInterval),
  failureRate: Schema.optionalKey(UnitInterval),
  p95DurationMs: Schema.optionalKey(NonNegativeFinite),
  averageCostUsd: Schema.optionalKey(NonNegativeFinite),
  costStatus: Schema.Literals(["known", "unavailable"]),
  utility: Schema.optionalKey(Schema.Finite),
  rank: Schema.optionalKey(NonNegativeInteger)
});
export type RoutingCandidateDecision = typeof RoutingCandidateDecision.Type;

export const RoutingActivationConstraints = Schema.Struct({
  minimumDimensionQuality: Schema.optionalKey(Schema.Record(Schema.String, UnitInterval)),
  maximumFailureRate: Schema.optionalKey(UnitInterval)
});
export type RoutingActivationConstraints = typeof RoutingActivationConstraints.Type;

export const PublishedRoutingActivation = Schema.Struct({
  version: CompositionalRoutingVersion,
  generatedAt: Schema.String,
  basisDigest: Schema.String,
  evidenceDigest: Schema.String,
  classifierModel: Schema.String,
  objective: RoutingObjectivePolicy,
  maximumUnknownWeight: UnitInterval,
  constraints: Schema.optionalKey(RoutingActivationConstraints),
  dimensions: Schema.Array(WorkloadDimension),
  candidateModels: Schema.Array(Schema.String),
  evidence: Schema.Array(ModelDimensionEvidence)
});
export type PublishedRoutingActivation = typeof PublishedRoutingActivation.Type;

export const AutoRoutingDecision = Schema.Struct({
  version: CompositionalRoutingVersion,
  decomposition: RequestDecomposition,
  requirements: RequestRoutingRequirements,
  objective: RoutingObjectivePolicy,
  evidenceDigest: Schema.String,
  candidates: Schema.Array(RoutingCandidateDecision),
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String)
});
export type AutoRoutingDecision = typeof AutoRoutingDecision.Type;

const WORKLOAD_DIMENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;
const DIGEST_LIMIT = 256;

function assertNonEmptyDigest(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim() || value.length > DIGEST_LIMIT) {
    throw new Error(`${label} must be a non-empty, bounded digest`);
  }
}

function assertWorkloadDimension(dimension: WorkloadDimension): void {
  if (!WORKLOAD_DIMENSION_ID_PATTERN.test(dimension.id)) {
    throw new Error(`invalid routing dimension id ${JSON.stringify(dimension.id)}`);
  }
  if (
    dimension.description.length === 0 ||
    dimension.description !== dimension.description.trim() ||
    dimension.description.length > WORKLOAD_DIMENSION_DESCRIPTION_LIMIT
  ) {
    throw new Error(`routing dimension ${JSON.stringify(dimension.id)} has an invalid description`);
  }
  if (dimension.includes.length === 0 || dimension.excludes.length === 0) {
    throw new Error(
      `routing dimension ${JSON.stringify(dimension.id)} must define inclusion and exclusion boundaries`
    );
  }
  const boundaries = new Set<string>();
  for (const [kind, values] of [
    ["inclusion", dimension.includes],
    ["exclusion", dimension.excludes]
  ] as const) {
    for (const value of values) {
      if (
        value.length === 0 ||
        value !== value.trim() ||
        value.length > WORKLOAD_DIMENSION_BOUNDARY_LIMIT
      ) {
        throw new Error(
          `routing dimension ${JSON.stringify(dimension.id)} has an invalid ${kind} boundary`
        );
      }
      const normalized = value.toLowerCase();
      if (boundaries.has(normalized)) {
        throw new Error(
          `routing dimension ${JSON.stringify(dimension.id)} has duplicate boundaries`
        );
      }
      boundaries.add(normalized);
    }
  }
}

export function assertRoutingBasis(basis: RoutingBasis): void {
  assertNonEmptyDigest(basis.basisDigest, "definition-set digest");
  if (
    basis.dimensions.length < ROUTING_BASIS_DIMENSION_MIN ||
    basis.dimensions.length > ROUTING_BASIS_DIMENSION_MAX
  ) {
    throw new Error(
      `routing dimension basis must contain between ${String(ROUTING_BASIS_DIMENSION_MIN)} and ${String(
        ROUTING_BASIS_DIMENSION_MAX
      )} dimensions`
    );
  }
  const ids = new Set<string>();
  for (const dimension of basis.dimensions) {
    assertWorkloadDimension(dimension);
    if (ids.has(dimension.id)) {
      throw new Error(`duplicate routing dimension ${JSON.stringify(dimension.id)}`);
    }
    ids.add(dimension.id);
  }
  if (JSON.stringify(basis.dimensions).length > CLASSIFIER_BASIS_TEXT_LIMIT) {
    throw new Error(
      `routing dimension basis exceeds ${String(CLASSIFIER_BASIS_TEXT_LIMIT)} characters`
    );
  }
}

export function assertDecompositionInput(input: DecompositionInput): void {
  if (input.request.length === 0 || input.request !== input.request.trim()) {
    throw new Error("dimension classification request must be non-empty");
  }
  assertRoutingBasis({
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest: "classification-input",
    dimensions: input.dimensions
  });
}

function assertDimensionVector(
  weights: ReadonlyArray<DimensionWeight>,
  unknownWeight: number,
  expectedDimensionIds?: ReadonlySet<string>
): void {
  const actualDimensionIds = new Set<string>();
  let sum = unknownWeight;
  for (const entry of weights) {
    if (!WORKLOAD_DIMENSION_ID_PATTERN.test(entry.dimensionId)) {
      throw new Error(`invalid routing dimension weight id ${JSON.stringify(entry.dimensionId)}`);
    }
    if (actualDimensionIds.has(entry.dimensionId)) {
      throw new Error(`duplicate routing dimension weight ${JSON.stringify(entry.dimensionId)}`);
    }
    actualDimensionIds.add(entry.dimensionId);
    sum += entry.weight;
    if (expectedDimensionIds !== undefined && !expectedDimensionIds.has(entry.dimensionId)) {
      throw new Error(`unknown routing dimension weight ${JSON.stringify(entry.dimensionId)}`);
    }
  }
  if (expectedDimensionIds !== undefined) {
    for (const dimensionId of expectedDimensionIds) {
      if (!actualDimensionIds.has(dimensionId)) {
        throw new Error(`missing routing dimension weight ${JSON.stringify(dimensionId)}`);
      }
    }
  }
  if (Math.abs(sum - 1) > REQUEST_DECOMPOSITION_TOLERANCE) {
    throw new Error("routing dimension weights and unknown weight must sum to one");
  }
}

export function assertDecompositionResult(result: DecompositionResult, basis: RoutingBasis): void {
  assertRoutingBasis(basis);
  assertDimensionVector(
    result.weights,
    result.unknownWeight,
    new Set(basis.dimensions.map((dimension) => dimension.id))
  );
}

export function assertRequestDecomposition(
  decomposition: RequestDecomposition,
  basis: RoutingBasis
): void {
  if (decomposition.basisDigest !== basis.basisDigest) {
    throw new Error(
      "request decomposition definition-set digest does not match the dimension basis"
    );
  }
  assertDecompositionResult(decomposition, basis);
}

export function assertRoutingObjectivePolicy(policy: RoutingObjectivePolicy): void {
  if (policy.kind !== "balanced") return;
  const sum = policy.weights.quality + policy.weights.cost + policy.weights.latency;
  if (Math.abs(sum - 1) > REQUEST_DECOMPOSITION_TOLERANCE) {
    throw new Error("balanced routing objective weights must sum to one");
  }
}

export function assertPublishedRoutingActivation(snapshot: PublishedRoutingActivation): void {
  const basis: RoutingBasis = {
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest: snapshot.basisDigest,
    dimensions: snapshot.dimensions
  };
  assertRoutingBasis(basis);
  assertExplicitEvalModel(snapshot.classifierModel, "classifier");
  assertRoutingObjectivePolicy(snapshot.objective);
  assertNonEmptyDigest(snapshot.evidenceDigest, "evidence digest");
  if (snapshot.candidateModels.length === 0) {
    throw new Error("routing snapshot must contain at least one candidate model");
  }
  const candidates = new Set<string>();
  for (const model of snapshot.candidateModels) {
    assertExplicitEvalModel(model, "candidate");
    if (candidates.has(model)) {
      throw new Error(`duplicate routing snapshot candidate ${JSON.stringify(model)}`);
    }
    candidates.add(model);
  }
  const dimensionIds = new Set(snapshot.dimensions.map((dimension) => dimension.id));
  for (const [dimensionId] of Object.entries(snapshot.constraints?.minimumDimensionQuality ?? {})) {
    if (!dimensionIds.has(dimensionId)) {
      throw new Error(
        `routing activation quality constraint refers to unknown dimension ${JSON.stringify(
          dimensionId
        )}`
      );
    }
  }
  const cells = new Set<string>();
  const suiteDigestByDimension = new Map<string, string>();
  for (const evidence of snapshot.evidence) {
    assertExplicitEvalModel(evidence.model, "candidate");
    if (!candidates.has(evidence.model)) {
      throw new Error(`evidence contains unknown candidate ${JSON.stringify(evidence.model)}`);
    }
    if (!dimensionIds.has(evidence.dimensionId)) {
      throw new Error(
        `evidence contains unknown dimension ${JSON.stringify(evidence.dimensionId)}`
      );
    }
    const cell = `${evidence.model}\u0000${evidence.dimensionId}`;
    if (cells.has(cell)) {
      throw new Error(
        `duplicate model-dimension evidence for ${JSON.stringify(evidence.model)} and ${JSON.stringify(
          evidence.dimensionId
        )}`
      );
    }
    cells.add(cell);
    assertNonEmptyDigest(evidence.suiteDigest, "suite digest");
    assertNonEmptyDigest(evidence.evidenceDigest, "cell evidence digest");
    const dimensionSuiteDigest = suiteDigestByDimension.get(evidence.dimensionId);
    if (dimensionSuiteDigest !== undefined && dimensionSuiteDigest !== evidence.suiteDigest) {
      throw new Error(
        `routing dimension ${JSON.stringify(evidence.dimensionId)} has inconsistent suite digests`
      );
    }
    suiteDigestByDimension.set(evidence.dimensionId, evidence.suiteDigest);
    if (evidence.quality.sampleCount === 0) {
      throw new Error("model-dimension evidence sample count must be greater than zero");
    }
    if (evidence.quality.lowerConfidenceBound > evidence.quality.passRate) {
      throw new Error("quality lower confidence bound cannot exceed pass rate");
    }
    if (evidence.quality.passRate + evidence.failureRate > 1 + REQUEST_DECOMPOSITION_TOLERANCE) {
      throw new Error("model-dimension pass and failure rates cannot sum above one");
    }
    if (evidence.unpricedCalls > 0 && evidence.averageCostUsd !== undefined) {
      throw new Error("partially priced model-dimension evidence must not report an average cost");
    }
    if (evidence.unpricedCalls === 0 && evidence.averageCostUsd === undefined) {
      throw new Error("fully priced model-dimension evidence must report its average cost");
    }
  }
  for (const model of candidates) {
    for (const dimensionId of dimensionIds) {
      if (!cells.has(`${model}\u0000${dimensionId}`)) {
        throw new Error(
          `missing model-dimension evidence for ${JSON.stringify(model)} and ${JSON.stringify(dimensionId)}`
        );
      }
    }
  }
}

export function assertAutoRoutingDecision(
  decision: AutoRoutingDecision,
  snapshot: PublishedRoutingActivation
): void {
  assertPublishedRoutingActivation(snapshot);
  assertRequestDecomposition(decision.decomposition, {
    version: COMPOSITIONAL_ROUTING_VERSION,
    basisDigest: snapshot.basisDigest,
    dimensions: snapshot.dimensions
  });
  assertRoutingObjectivePolicy(decision.objective);
  if (decision.evidenceDigest !== snapshot.evidenceDigest) {
    throw new Error("routing decision evidence digest does not match the snapshot");
  }
  const expectedModels = new Set(snapshot.candidateModels);
  const decisions = new Map<string, RoutingCandidateDecision>();
  for (const candidate of decision.candidates) {
    assertExplicitEvalModel(candidate.model, "candidate");
    if (!expectedModels.has(candidate.model)) {
      throw new Error(
        `routing decision contains unknown candidate ${JSON.stringify(candidate.model)}`
      );
    }
    if (decisions.has(candidate.model)) {
      throw new Error(
        `routing decision contains duplicate candidate ${JSON.stringify(candidate.model)}`
      );
    }
    const hasExclusionReasons = candidate.exclusionReasons.length > 0;
    if (
      (candidate.eligible && hasExclusionReasons) ||
      (!candidate.eligible && !hasExclusionReasons)
    ) {
      throw new Error(
        `routing candidate ${JSON.stringify(candidate.model)} has inconsistent eligibility`
      );
    }
    if (candidate.eligible && candidate.rank === undefined) {
      throw new Error(`eligible routing candidate ${JSON.stringify(candidate.model)} has no rank`);
    }
    if (!candidate.eligible && candidate.rank !== undefined) {
      throw new Error(`ineligible routing candidate ${JSON.stringify(candidate.model)} has a rank`);
    }
    if (candidate.costStatus === "known" && candidate.averageCostUsd === undefined) {
      throw new Error(`routing candidate ${JSON.stringify(candidate.model)} has no known cost`);
    }
    if (candidate.costStatus === "unavailable" && candidate.averageCostUsd !== undefined) {
      throw new Error(
        `routing candidate ${JSON.stringify(candidate.model)} reports an unavailable cost`
      );
    }
    decisions.set(candidate.model, candidate);
  }
  for (const model of expectedModels) {
    if (!decisions.has(model)) {
      throw new Error(`routing decision is missing candidate ${JSON.stringify(model)}`);
    }
  }
  const ranked = [decision.selectedModel, ...decision.fallbackModels];
  const rankedModels = new Set<string>();
  for (const [index, model] of ranked.entries()) {
    const candidate = decisions.get(model);
    if (candidate === undefined) {
      throw new Error(`routing decision ranks unknown candidate ${JSON.stringify(model)}`);
    }
    if (!candidate.eligible) {
      throw new Error(`routing decision ranks ineligible candidate ${JSON.stringify(model)}`);
    }
    if (rankedModels.has(model)) {
      throw new Error(`routing decision ranks duplicate candidate ${JSON.stringify(model)}`);
    }
    if (candidate.rank !== index + 1) {
      throw new Error(`routing decision has inconsistent rank for ${JSON.stringify(model)}`);
    }
    rankedModels.add(model);
  }
  const eligibleCount = decision.candidates.filter((candidate) => candidate.eligible).length;
  if (rankedModels.size !== eligibleCount) {
    throw new Error("routing decision must rank every eligible candidate");
  }
}

/** Evaluation must never select the online auto-router. */
export const EVAL_FORBIDDEN_MODELS = ["auto", "router", "default"] as const;

export const EvalRole = Schema.Literals(["author", "classifier", "candidate", "judge"]);
export type EvalRole = typeof EvalRole.Type;

export const EvalAttribution = Schema.Struct({
  purpose: Schema.Literal("eval"),
  role: EvalRole,
  runId: Schema.String,
  caseId: Schema.optionalKey(Schema.String)
});
export type EvalAttribution = typeof EvalAttribution.Type;

export const EvalCase = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  expected: Schema.optionalKey(Schema.String)
});
export type EvalCase = typeof EvalCase.Type;

export const EvalSuiteSpec = Schema.Struct({
  version: EvalContractVersion,
  id: Schema.String,
  candidateModel: Schema.String,
  judgeModel: Schema.String,
  cases: Schema.Array(EvalCase)
});
export type EvalSuiteSpec = typeof EvalSuiteSpec.Type;

export const EvalCaseResult = Schema.Struct({
  caseId: Schema.String,
  candidateOutput: Schema.String,
  judgeOutput: Schema.optionalKey(Schema.String),
  passed: Schema.Boolean,
  error: Schema.optionalKey(Schema.String)
});
export type EvalCaseResult = typeof EvalCaseResult.Type;

export const EvalRunResult = Schema.Struct({
  version: EvalContractVersion,
  runId: Schema.String,
  suiteId: Schema.String,
  candidateModel: Schema.String,
  judgeModel: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  passed: NonNegativeInteger,
  failed: NonNegativeInteger,
  cases: Schema.Array(EvalCaseResult)
});
export type EvalRunResult = typeof EvalRunResult.Type;

export const EvalEvidence = Schema.Struct({
  version: EvalContractVersion,
  runId: Schema.String,
  digest: Schema.String,
  publishedAt: Schema.String
});
export type EvalEvidence = typeof EvalEvidence.Type;

export const EvalPolicy = Schema.Struct({
  version: EvalContractVersion,
  dedicatedToken: Schema.Literal(true),
  explicitModelIds: Schema.Literal(true),
  policyBypass: Schema.Literal(true),
  autoRouterForbidden: Schema.Literal(true),
  onlineRequestPathIsolated: Schema.Literal(true)
});
export type EvalPolicy = typeof EvalPolicy.Type;

export const EVAL_POLICY: EvalPolicy = {
  version: EVAL_CONTRACT_VERSION,
  dedicatedToken: true,
  explicitModelIds: true,
  policyBypass: true,
  autoRouterForbidden: true,
  onlineRequestPathIsolated: true
};

export const RoutingObjective = Schema.Literals([
  "lowest-cost",
  "lowest-latency",
  "highest-quality"
]);
export type RoutingObjective = typeof RoutingObjective.Type;

export const RoutingEligibility = Schema.Struct({
  minimumPassRate: Schema.optionalKey(UnitInterval),
  minimumJudgeScore: Schema.optionalKey(UnitInterval),
  maximumFailureRate: Schema.optionalKey(UnitInterval),
  maximumAverageCostUsd: Schema.optionalKey(NonNegativeFinite),
  maximumP95DurationMs: Schema.optionalKey(NonNegativeFinite)
});
export type RoutingEligibility = typeof RoutingEligibility.Type;

export const EvalComparisonRequest = Schema.Struct({
  version: EvalContractVersion,
  profileId: Schema.String,
  suitePath: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  judgeModel: Schema.String,
  gatewayUrl: Schema.String,
  expectedCaseIds: Schema.optionalKey(Schema.Array(Schema.String)),
  expectedCallCount: Schema.optionalKey(NonNegativeInteger),
  maxOutputTokens: Schema.optionalKey(NonNegativeInteger),
  suiteDigest: Schema.optionalKey(Schema.String),
  concurrency: Schema.optionalKey(NonNegativeInteger),
  timeoutMs: Schema.optionalKey(NonNegativeFinite),
  spendLimitUsd: Schema.optionalKey(NonNegativeFinite)
});
export type EvalComparisonRequest = typeof EvalComparisonRequest.Type;

export const EvalRunManifest = Schema.Struct({
  version: Schema.Literal(1),
  profileId: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  judgeModel: Schema.String,
  caseCount: NonNegativeInteger,
  caseIds: Schema.Array(Schema.String),
  maxOutputTokens: NonNegativeInteger,
  expectedCallCount: NonNegativeInteger
});
export type EvalRunManifest = typeof EvalRunManifest.Type;

export const EvalMeasurement = Schema.Struct({
  costUsd: Schema.optionalKey(NonNegativeFinite),
  durationMs: Schema.optionalKey(NonNegativeFinite),
  judgeScore: Schema.optionalKey(UnitInterval),
  inputTokens: Schema.optionalKey(NonNegativeInteger),
  outputTokens: Schema.optionalKey(NonNegativeInteger)
});
export type EvalMeasurement = typeof EvalMeasurement.Type;

export const EvalComparisonCase = Schema.Struct({
  caseId: Schema.String,
  outcome: Schema.Literals(["passed", "failed", "unknown", "cutoff"]),
  measurement: EvalMeasurement,
  error: Schema.optionalKey(Schema.String)
});
export type EvalComparisonCase = typeof EvalComparisonCase.Type;

export const EvalModelComparison = Schema.Struct({
  model: Schema.String,
  cases: Schema.Array(EvalComparisonCase)
});
export type EvalModelComparison = typeof EvalModelComparison.Type;

export const EvalComparisonCall = Schema.Struct({
  role: Schema.Literals(["candidate", "judge"]),
  model: Schema.String,
  caseId: Schema.String,
  measurement: EvalMeasurement
});
export type EvalComparisonCall = typeof EvalComparisonCall.Type;

export const EvalComparisonResult = Schema.Struct({
  version: EvalContractVersion,
  comparisonId: Schema.String,
  profileId: Schema.String,
  suiteDigest: Schema.String,
  judgeModel: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  models: Schema.Array(EvalModelComparison),
  calls: Schema.optionalKey(Schema.Array(EvalComparisonCall))
});
export type EvalComparisonResult = typeof EvalComparisonResult.Type;

/** Aggregated measurements used by the deterministic policy compiler. */
export const ModelEvidence = Schema.Struct({
  model: Schema.String,
  sampleCount: NonNegativeInteger,
  passedCount: NonNegativeInteger,
  failedCount: NonNegativeInteger,
  unknownCount: NonNegativeInteger,
  cutoffCount: NonNegativeInteger,
  passRate: Schema.optionalKey(UnitInterval),
  failureRate: Schema.optionalKey(UnitInterval),
  averageJudgeScore: Schema.optionalKey(UnitInterval),
  averageCostUsd: Schema.optionalKey(NonNegativeFinite),
  p95DurationMs: Schema.optionalKey(NonNegativeFinite)
});
export type ModelEvidence = typeof ModelEvidence.Type;

export const RoutingRejection = Schema.Struct({
  model: Schema.String,
  reasons: Schema.Array(Schema.String)
});
export type RoutingRejection = typeof RoutingRejection.Type;

export const EvalSetupStage = Schema.Literals([
  "surface",
  "data",
  "criteria",
  "constraints",
  "candidates",
  "spend-approval",
  "publish",
  "completed"
]);
export type EvalSetupStage = typeof EvalSetupStage.Type;

export const EvalSetupRunMode = Schema.Literals(["pilot", "full", "save-only"]);
export type EvalSetupRunMode = typeof EvalSetupRunMode.Type;

export const EvalSetupState = Schema.Struct({
  version: Schema.Literal(EVAL_SETUP_VERSION),
  profileId: Schema.String,
  repositoryRoot: Schema.String,
  stage: EvalSetupStage,
  revision: Schema.Finite,
  updatedAt: Schema.String,
  openQuestion: Schema.optionalKey(Schema.String),
  answers: Schema.Record(Schema.String, Schema.String),
  generatedEvalPath: Schema.optionalKey(Schema.String),
  runMode: Schema.optionalKey(EvalSetupRunMode),
  comparisonId: Schema.optionalKey(Schema.String),
  publishApproved: Schema.optionalKey(Schema.Boolean)
});
export type EvalSetupState = typeof EvalSetupState.Type;

export const EvalSetupEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("question"),
    stage: EvalSetupStage,
    prompt: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("run-approved"),
    mode: EvalSetupRunMode
  }),
  Schema.Struct({
    type: Schema.Literal("comparison-completed"),
    comparisonId: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("publish-approved"),
    profileId: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("completed"),
    profileId: Schema.String
  })
]);
export type EvalSetupEvent = typeof EvalSetupEvent.Type;

export function isForbiddenEvalModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    EVAL_FORBIDDEN_MODELS.includes(normalized as (typeof EVAL_FORBIDDEN_MODELS)[number]) ||
    model !== model.trim() ||
    !/^[a-z0-9][a-z0-9-]*\/[^\s/][^\s]*$/u.test(model)
  );
}

export function assertExplicitEvalModel(
  model: string,
  role: EvalRole | "classifier" | "author"
): void {
  if (isForbiddenEvalModel(model)) {
    throw new Error(
      `${role} model must be an explicit provider/model id, not ${JSON.stringify(model)}`
    );
  }
}
