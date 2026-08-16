import { Schema } from "effect";

/** Header that marks an eval egress call so the auto-router must not apply. */
export const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";

/** Attribution metadata for candidate and judge calls. */
export const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";

/**
 * Legacy header. `model: "auto"` classifies against every published profile
 * and does not use this header as the online selector.
 */
export const ROUTEKIT_ROUTING_PROFILE_HEADER = "x-routekit-profile";

export const EVAL_CONTRACT_VERSION = 1 as const;
export const ROUTING_SNAPSHOT_VERSION = 1 as const;
export const EVAL_SETUP_VERSION = 1 as const;
export const CLASSIFIABLE_PROFILE_LIMIT = 64;
export const CLASSIFIABLE_PROFILE_DESCRIPTION_LIMIT = 1_024;
export const CLASSIFIABLE_PROFILE_EVIDENCE_LIMIT = 64;
export const CLASSIFIABLE_PROFILE_FALLBACK_LIMIT = 32;
export const CLASSIFIER_CATALOG_TEXT_LIMIT = 64 * 1_024;

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
  minimumPassRate: Schema.optionalKey(UnitInterval),
  minimumJudgeScore: Schema.optionalKey(UnitInterval),
  maximumFailureRate: Schema.optionalKey(UnitInterval),
  maximumAverageCostUsd: Schema.optionalKey(NonNegativeFinite),
  maximumP95DurationMs: Schema.optionalKey(NonNegativeFinite)
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
  objective: RoutingObjective,
  description: Schema.optionalKey(Schema.String)
});
export type RoutingProfile = typeof RoutingProfile.Type;

export const EvalComparisonRequest = Schema.Struct({
  version: EvalContractVersion,
  profileId: Schema.String,
  suitePath: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  judgeModel: Schema.String,
  gatewayUrl: Schema.String,
  concurrency: Schema.optionalKey(NonNegativeInteger),
  timeoutMs: Schema.optionalKey(NonNegativeFinite),
  spendLimitUsd: Schema.optionalKey(NonNegativeFinite)
});
export type EvalComparisonRequest = typeof EvalComparisonRequest.Type;

export const EvalRunManifest = Schema.Struct({
  version: Schema.Literal(1),
  candidateModels: Schema.Array(Schema.String),
  judgeModel: Schema.String,
  caseCount: NonNegativeInteger,
  maxOutputTokens: NonNegativeInteger
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

export const CompiledRoutingPolicy = Schema.Struct({
  version: Schema.Literal(ROUTING_SNAPSHOT_VERSION),
  profileId: Schema.String,
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String),
  objective: RoutingObjective,
  suiteDigest: Schema.String,
  evidenceDigest: Schema.String,
  evidence: Schema.Array(ModelEvidence),
  rejected: Schema.Array(RoutingRejection),
  description: Schema.optionalKey(Schema.String)
});
export type CompiledRoutingPolicy = typeof CompiledRoutingPolicy.Type;

/** Compact aggregate evidence shown to the online request classifier. */
export const ClassifiableProfileEvidence = Schema.Struct({
  model: Schema.String,
  passRate: Schema.optionalKey(UnitInterval),
  averageJudgeScore: Schema.optionalKey(UnitInterval),
  averageCostUsd: Schema.optionalKey(NonNegativeFinite)
});
export type ClassifiableProfileEvidence = typeof ClassifiableProfileEvidence.Type;

export const PublishedRoutingProfile = Schema.Struct({
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String),
  objective: RoutingObjective,
  suiteDigest: Schema.String,
  evidenceDigest: Schema.String,
  publishedAt: Schema.String,
  description: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Array(ClassifiableProfileEvidence))
});
export type PublishedRoutingProfile = typeof PublishedRoutingProfile.Type;

export const ClassifiableProfile = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  selectedModel: Schema.String,
  fallbackModels: Schema.Array(Schema.String),
  evidence: Schema.Array(ClassifiableProfileEvidence)
});
export type ClassifiableProfile = typeof ClassifiableProfile.Type;

export const ClassificationInput = Schema.Struct({
  request: Schema.String,
  profiles: Schema.Array(ClassifiableProfile)
});
export type ClassificationInput = typeof ClassificationInput.Type;

const ClassificationProbability = Schema.Finite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      value >= 0 && value <= 1 ? undefined : "probability must be between 0 and 1"
    )
  )
);

export const ClassificationScore = Schema.Struct({
  profileId: Schema.String,
  probability: ClassificationProbability
});
export type ClassificationScore = typeof ClassificationScore.Type;

export const ClassificationResult = Schema.Struct({
  scores: Schema.Array(ClassificationScore)
});
export type ClassificationResult = typeof ClassificationResult.Type;

/**
 * Compact online artifact. It includes profile winners and compact model
 * evidence for classification, and excludes raw cases, prompts, candidate
 * outputs, judge outputs, credentials, and authoring state.
 */
export const PublishedRoutingSnapshot = Schema.Struct({
  version: Schema.Literal(ROUTING_SNAPSHOT_VERSION),
  generatedAt: Schema.String,
  profiles: Schema.Record(Schema.String, PublishedRoutingProfile)
});
export type PublishedRoutingSnapshot = typeof PublishedRoutingSnapshot.Type;

export function assertPublishedRoutingCatalog(
  profiles: Readonly<Record<string, PublishedRoutingProfile>>
): void {
  const entries = Object.entries(profiles);
  if (entries.length > CLASSIFIABLE_PROFILE_LIMIT) {
    throw new Error(
      `published routing catalog exceeds ${String(CLASSIFIABLE_PROFILE_LIMIT)} profiles`
    );
  }
  for (const [id, profile] of entries) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(id)) {
      throw new Error(`invalid published routing profile id ${JSON.stringify(id)}`);
    }
    if ((profile.description ?? id).trim().length > CLASSIFIABLE_PROFILE_DESCRIPTION_LIMIT) {
      throw new Error(
        `published routing profile ${JSON.stringify(id)} has an oversized description`
      );
    }
    if (profile.fallbackModels.length > CLASSIFIABLE_PROFILE_FALLBACK_LIMIT) {
      throw new Error(`published routing profile ${JSON.stringify(id)} has too many fallbacks`);
    }
    if ((profile.evidence?.length ?? 0) > CLASSIFIABLE_PROFILE_EVIDENCE_LIMIT) {
      throw new Error(`published routing profile ${JSON.stringify(id)} has too much evidence`);
    }
    assertExplicitEvalModel(profile.selectedModel, "candidate");
    const ranked = new Set<string>([profile.selectedModel]);
    for (const model of profile.fallbackModels) {
      assertExplicitEvalModel(model, "candidate");
      if (ranked.has(model)) {
        throw new Error(`published routing profile ${JSON.stringify(id)} has duplicate models`);
      }
      ranked.add(model);
    }
    const evidenceModels = new Set<string>();
    for (const evidence of profile.evidence ?? []) {
      assertExplicitEvalModel(evidence.model, "candidate");
      if (evidenceModels.has(evidence.model)) {
        throw new Error(`published routing profile ${JSON.stringify(id)} has duplicate evidence`);
      }
      evidenceModels.add(evidence.model);
    }
  }
  const projection = entries.map(([id, profile]) => ({
    id,
    description: profile.description?.trim() || id,
    selectedModel: profile.selectedModel,
    fallbackModels: profile.fallbackModels,
    evidence: profile.evidence ?? []
  }));
  if (JSON.stringify(projection).length > CLASSIFIER_CATALOG_TEXT_LIMIT) {
    throw new Error(
      `published routing catalog exceeds ${String(CLASSIFIER_CATALOG_TEXT_LIMIT)} characters`
    );
  }
}

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
    EVAL_FORBIDDEN_MODELS.includes(normalized as (typeof EVAL_FORBIDDEN_MODELS)[number]) ||
    model !== model.trim() ||
    !/^[a-z0-9][a-z0-9-]*\/[^\s/][^\s]*$/u.test(model)
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
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(profile.id)) {
    throw new Error(
      "routing profile id must start with a lowercase letter or digit and contain only lowercase letters, digits, or hyphens"
    );
  }
  if (profile.suite.trim().length === 0) throw new Error("routing profile suite must not be empty");
  if (profile.candidates.length === 0) {
    throw new Error("routing profile must include at least one candidate model");
  }
  const candidates = new Set<string>();
  for (const model of profile.candidates) {
    assertExplicitEvalModel(model, "candidate");
    if (candidates.has(model))
      throw new Error(`duplicate candidate model ${JSON.stringify(model)}`);
    candidates.add(model);
  }
  assertExplicitEvalModel(profile.judge, "judge");
  for (const [name, value] of Object.entries(profile.eligibility)) {
    if (value === undefined || value < 0) {
      if (value !== undefined) throw new Error(`${name} must be non-negative`);
      continue;
    }
    if ((name === "minimumPassRate" || name === "maximumFailureRate") && value > 1) {
      throw new Error(`${name} must be between 0 and 1`);
    }
  }
}

export function assertCompiledRoutingPolicy(policy: CompiledRoutingPolicy): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(policy.profileId)) {
    throw new Error(`invalid compiled routing profile id ${JSON.stringify(policy.profileId)}`);
  }
  assertExplicitEvalModel(policy.selectedModel, "candidate");
  const ranked = new Set<string>([policy.selectedModel]);
  for (const model of policy.fallbackModels) {
    assertExplicitEvalModel(model, "candidate");
    if (ranked.has(model))
      throw new Error(`duplicate compiled routing model ${JSON.stringify(model)}`);
    ranked.add(model);
  }
  const evidenceModels = new Set<string>();
  for (const evidence of policy.evidence) {
    assertExplicitEvalModel(evidence.model, "candidate");
    if (evidenceModels.has(evidence.model)) {
      throw new Error(`duplicate model evidence ${JSON.stringify(evidence.model)}`);
    }
    evidenceModels.add(evidence.model);
    const total =
      evidence.passedCount + evidence.failedCount + evidence.unknownCount + evidence.cutoffCount;
    if (total !== evidence.sampleCount) {
      throw new Error(
        `model evidence counts do not sum to sampleCount for ${JSON.stringify(evidence.model)}`
      );
    }
  }
}
