import { Schema } from "effect";

/** Header that marks an eval egress call so the auto-router must not apply. */
export const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";

/** Attribution metadata for candidate and judge calls. */
export const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";

/** Explicit routing profile selected by callers using `model: "auto"`. */
export const ROUTEKIT_ROUTING_PROFILE_HEADER = "x-routekit-profile";

export const EVAL_CONTRACT_VERSION = 1 as const;
export const ROUTING_SNAPSHOT_VERSION = 1 as const;
export const EVAL_SETUP_VERSION = 1 as const;

export const EvalContractVersion = Schema.Literal(EVAL_CONTRACT_VERSION);
export type EvalContractVersion = typeof EvalContractVersion.Type;

/** Evaluation must never select the online auto-router. */
export const EVAL_FORBIDDEN_MODELS = ["auto", "router", "default"] as const;

export const EvalRole = Schema.Literals(["candidate", "judge"]);
export type EvalRole = typeof EvalRole.Type;

export const EvalAttribution = Schema.Struct({
  purpose: Schema.Literal("eval"),
  role: EvalRole,
  runId: Schema.String,
  caseId: Schema.String
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
  passed: Schema.Finite,
  failed: Schema.Finite,
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

export const EvalWorkerRequest = Schema.Struct({
  version: EvalContractVersion,
  type: Schema.Literal("run"),
  id: Schema.String,
  spec: EvalSuiteSpec,
  gatewayUrl: Schema.String,
  token: Schema.String
});
export type EvalWorkerRequest = typeof EvalWorkerRequest.Type;

export const EvalWorkerResponse = Schema.Union([
  Schema.Struct({
    version: EvalContractVersion,
    type: Schema.Literal("result"),
    id: Schema.String,
    result: EvalRunResult
  }),
  Schema.Struct({
    version: EvalContractVersion,
    type: Schema.Literal("error"),
    id: Schema.String,
    error: Schema.String
  })
]);
export type EvalWorkerResponse = typeof EvalWorkerResponse.Type;

export const RoutingObjective = Schema.Literals([
  "lowest-cost",
  "lowest-latency",
  "highest-quality"
]);
export type RoutingObjective = typeof RoutingObjective.Type;

export const RoutingEligibility = Schema.Struct({
  minimumPassRate: Schema.optionalKey(Schema.Finite),
  minimumJudgeScore: Schema.optionalKey(Schema.Finite),
  maximumFailureRate: Schema.optionalKey(Schema.Finite),
  maximumAverageCostUsd: Schema.optionalKey(Schema.Finite),
  maximumP95DurationMs: Schema.optionalKey(Schema.Finite)
});
export type RoutingEligibility = typeof RoutingEligibility.Type;

/**
 * Authored input connecting an eval suite to the models and objective used to
 * compile an online routing decision.
 */
export const RoutingProfile = Schema.Struct({
  version: EvalContractVersion,
  id: Schema.String,
  suite: Schema.String,
  candidates: Schema.Array(Schema.String),
  judge: Schema.String,
  eligibility: RoutingEligibility,
  objective: RoutingObjective
});
export type RoutingProfile = typeof RoutingProfile.Type;

export const EvalComparisonRequest = Schema.Struct({
  version: EvalContractVersion,
  profileId: Schema.String,
  suitePath: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  judgeModel: Schema.String,
  gatewayUrl: Schema.String,
  concurrency: Schema.optionalKey(Schema.Finite),
  timeoutMs: Schema.optionalKey(Schema.Finite),
  spendLimitUsd: Schema.optionalKey(Schema.Finite)
});
export type EvalComparisonRequest = typeof EvalComparisonRequest.Type;

export const EvalMeasurement = Schema.Struct({
  costUsd: Schema.optionalKey(Schema.Finite),
  durationMs: Schema.optionalKey(Schema.Finite),
  judgeScore: Schema.optionalKey(Schema.Finite),
  inputTokens: Schema.optionalKey(Schema.Finite),
  outputTokens: Schema.optionalKey(Schema.Finite)
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

export const EvalComparisonResult = Schema.Struct({
  version: EvalContractVersion,
  comparisonId: Schema.String,
  profileId: Schema.String,
  suiteDigest: Schema.String,
  judgeModel: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  models: Schema.Array(EvalModelComparison)
});
export type EvalComparisonResult = typeof EvalComparisonResult.Type;

/** Aggregated measurements used by the deterministic policy compiler. */
export const ModelEvidence = Schema.Struct({
  model: Schema.String,
  sampleCount: Schema.Finite,
  passedCount: Schema.Finite,
  failedCount: Schema.Finite,
  unknownCount: Schema.Finite,
  cutoffCount: Schema.Finite,
  passRate: Schema.optionalKey(Schema.Finite),
  failureRate: Schema.optionalKey(Schema.Finite),
  averageJudgeScore: Schema.optionalKey(Schema.Finite),
  averageCostUsd: Schema.optionalKey(Schema.Finite),
  p95DurationMs: Schema.optionalKey(Schema.Finite)
});
export type ModelEvidence = typeof ModelEvidence.Type;

export const RoutingRejection = Schema.Struct({
  model: Schema.String,
  reasons: Schema.Array(Schema.String)
});
export type RoutingRejection = typeof RoutingRejection.Type;

export const CompiledRoutingPolicy = Schema.Struct({
  version: Schema.Literal(ROUTING_SNAPSHOT_VERSION),
  profileId: Schema.String,
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String),
  objective: RoutingObjective,
  suiteDigest: Schema.String,
  evidenceDigest: Schema.String,
  evidence: Schema.Array(ModelEvidence),
  rejected: Schema.Array(RoutingRejection)
});
export type CompiledRoutingPolicy = typeof CompiledRoutingPolicy.Type;

export const PublishedRoutingProfile = Schema.Struct({
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String),
  objective: RoutingObjective,
  suiteDigest: Schema.String,
  evidenceDigest: Schema.String,
  publishedAt: Schema.String
});
export type PublishedRoutingProfile = typeof PublishedRoutingProfile.Type;

/**
 * Compact online artifact. It intentionally excludes raw cases, prompts,
 * candidate outputs, judge outputs, credentials, and authoring state.
 */
export const PublishedRoutingSnapshot = Schema.Struct({
  version: Schema.Literal(ROUTING_SNAPSHOT_VERSION),
  generatedAt: Schema.String,
  profiles: Schema.Record(Schema.String, PublishedRoutingProfile)
});
export type PublishedRoutingSnapshot = typeof PublishedRoutingSnapshot.Type;

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
  generatedProfilePath: Schema.optionalKey(Schema.String),
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
    type: Schema.Literal("artifacts-generated"),
    evalPath: Schema.String,
    profilePath: Schema.String
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
    normalized.length === 0 ||
    EVAL_FORBIDDEN_MODELS.includes(normalized as (typeof EVAL_FORBIDDEN_MODELS)[number]) ||
    !model.includes("/")
  );
}

export function assertExplicitEvalModel(model: string, role: EvalRole): void {
  if (isForbiddenEvalModel(model)) {
    throw new Error(
      `${role} model must be an explicit provider/model id, not ${JSON.stringify(model)}`
    );
  }
}

export function assertRoutingProfile(profile: RoutingProfile): void {
  if (profile.id.trim().length === 0) throw new Error("routing profile id must not be empty");
  if (profile.suite.trim().length === 0) throw new Error("routing profile suite must not be empty");
  if (profile.candidates.length === 0) {
    throw new Error("routing profile must include at least one candidate model");
  }
  const candidates = new Set<string>();
  for (const model of profile.candidates) {
    assertExplicitEvalModel(model, "candidate");
    if (candidates.has(model)) throw new Error(`duplicate candidate model ${JSON.stringify(model)}`);
    candidates.add(model);
  }
  assertExplicitEvalModel(profile.judge, "judge");
  for (const [name, value] of Object.entries(profile.eligibility)) {
    if (value === undefined || value < 0) {
      if (value !== undefined) throw new Error(`${name} must be non-negative`);
      continue;
    }
    if (
      (name === "minimumPassRate" || name === "maximumFailureRate") &&
      value > 1
    ) {
      throw new Error(`${name} must be between 0 and 1`);
    }
  }
}
