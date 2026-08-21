import {
  DecompositionResult,
  EvalComparisonResult,
  type EvalComparisonResult as EvalComparisonResultType,
  PublishedRoutingActivation,
  RoutingActivationConstraints,
  RequestRoutingRequirements,
  RoutingObjectivePolicy,
  WorkloadDimension
} from "@velum-labs/routekit-eval-contracts";
import { Schema } from "effect";

export const EVAL_PROJECT_VERSION = 1 as const;

export const EvalProjectQuestion = Schema.Struct({
  id: Schema.Literals([
    "workload-description",
    "candidate-models",
    "classifier-model",
    "author-model",
    "judge-model",
    "routing-objective",
    "maximum-unknown-weight",
    "routing-constraints"
  ]),
  prompt: Schema.String,
  options: Schema.Array(Schema.String)
});
export type EvalProjectQuestion = typeof EvalProjectQuestion.Type;

const WorkloadDescriptionRequired = Schema.TaggedStruct("WorkloadDescriptionRequired", {});

const CandidateModelsRequired = Schema.TaggedStruct("CandidateModelsRequired", {
  workloadDescription: Schema.String
});

const ClassifierModelRequired = Schema.TaggedStruct("ClassifierModelRequired", {
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String)
});

const AuthorModelRequired = Schema.TaggedStruct("AuthorModelRequired", {
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String
});

const JudgeModelRequired = Schema.TaggedStruct("JudgeModelRequired", {
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String,
  authorModel: Schema.String
});

const RoutingObjectiveRequired = Schema.TaggedStruct("RoutingObjectiveRequired", {
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String,
  authorModel: Schema.String,
  judgeModel: Schema.String
});

const MaximumUnknownWeightRequired = Schema.TaggedStruct("MaximumUnknownWeightRequired", {
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String,
  authorModel: Schema.String,
  judgeModel: Schema.String,
  objective: RoutingObjectivePolicy
});

const RoutingConstraintsRequired = Schema.TaggedStruct("RoutingConstraintsRequired", {
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String,
  authorModel: Schema.String,
  judgeModel: Schema.String,
  objective: RoutingObjectivePolicy,
  maximumUnknownWeight: Schema.Finite
});

export const EvalProjectSetupProgress = Schema.Union([
  WorkloadDescriptionRequired,
  CandidateModelsRequired,
  ClassifierModelRequired,
  AuthorModelRequired,
  JudgeModelRequired,
  RoutingObjectiveRequired,
  MaximumUnknownWeightRequired,
  RoutingConstraintsRequired
]);
export type EvalProjectSetupProgress = typeof EvalProjectSetupProgress.Type;

export const EvalProjectConfiguration = Schema.Struct({
  workloadDescription: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String,
  authorModel: Schema.String,
  judgeModel: Schema.String,
  objective: RoutingObjectivePolicy,
  maximumUnknownWeight: Schema.Finite,
  constraints: Schema.optionalKey(RoutingActivationConstraints)
});
export type EvalProjectConfiguration = typeof EvalProjectConfiguration.Type;

export const EvalProposedDimension = Schema.Struct({
  ...WorkloadDimension.fields,
  inScopeRequest: Schema.String,
  nearMissRequest: Schema.String
});
export type EvalProposedDimension = typeof EvalProposedDimension.Type;

export const EvalDimensionContrast = Schema.Struct({
  dimensionId: Schema.String,
  inScopeRequest: Schema.optionalKey(Schema.String),
  nearMissRequest: Schema.optionalKey(Schema.String)
});
export type EvalDimensionContrast = typeof EvalDimensionContrast.Type;

export const EvalRoutingBasisProposal = Schema.Struct({
  version: Schema.Literal(2),
  basisDigest: Schema.String,
  dimensions: Schema.Array(WorkloadDimension),
  // Optional only so legacy or manually damaged artifacts reach the named
  // approval gate instead of failing as an opaque decode error.
  dimensionContrasts: Schema.optionalKey(Schema.Array(EvalDimensionContrast))
});
export type EvalRoutingBasisProposal = typeof EvalRoutingBasisProposal.Type;

const NonNegativeInteger = Schema.Finite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      value >= 0 && Number.isInteger(value) ? undefined : "value must be a non-negative integer"
    )
  )
);
const NonNegativeFinite = Schema.Finite.pipe(
  Schema.check(
    Schema.makeFilter((value: number) =>
      value >= 0 ? undefined : "value must be a non-negative finite number"
    )
  )
);

const ProjectCommon = {
  version: Schema.Literal(EVAL_PROJECT_VERSION),
  projectId: Schema.String,
  revision: NonNegativeInteger,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  sourceInventory: Schema.Array(Schema.String)
} as const;

const SetupRequiredState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("setup-required"),
  progress: EvalProjectSetupProgress
});

const DimensionsReviewState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("dimensions-review"),
  configuration: EvalProjectConfiguration
});

const EvaluationsReviewState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("evaluations-review"),
  configuration: EvalProjectConfiguration,
  basisDigest: Schema.String
});

const ReadyState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("ready"),
  configuration: EvalProjectConfiguration,
  basisDigest: Schema.String,
  evaluationDigest: Schema.String
});

const RunningState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("running"),
  configuration: EvalProjectConfiguration,
  basisDigest: Schema.String,
  evaluationDigest: Schema.String,
  planId: Schema.String,
  runId: Schema.String
});

const QualifiedState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("qualified"),
  configuration: EvalProjectConfiguration,
  basisDigest: Schema.String,
  evaluationDigest: Schema.String,
  runId: Schema.String,
  reportPath: Schema.String
});

const ActivatedState = Schema.Struct({
  ...ProjectCommon,
  stage: Schema.Literal("activated"),
  configuration: EvalProjectConfiguration,
  basisDigest: Schema.String,
  evaluationDigest: Schema.String,
  runId: Schema.String,
  reportPath: Schema.String,
  evidenceDigest: Schema.String,
  targetIdentity: Schema.String
});

export const EvalProjectState = Schema.Union([
  SetupRequiredState,
  DimensionsReviewState,
  EvaluationsReviewState,
  ReadyState,
  RunningState,
  QualifiedState,
  ActivatedState
]);
export type EvalProjectState = typeof EvalProjectState.Type;

export const EvalDimensionCase = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  context: Schema.optionalKey(Schema.String),
  rubric: Schema.String
});
export type EvalDimensionCase = typeof EvalDimensionCase.Type;

export const EvalDimensionSuite = Schema.Struct({
  version: Schema.Literal(EVAL_PROJECT_VERSION),
  dimensionId: Schema.String,
  maximumOutputTokens: NonNegativeInteger,
  cases: Schema.Array(EvalDimensionCase)
});
export type EvalDimensionSuite = typeof EvalDimensionSuite.Type;

export const EvalDecompositionBenchmarkCase = Schema.Struct({
  id: Schema.String,
  request: Schema.String,
  expected: DecompositionResult
});
export type EvalDecompositionBenchmarkCase = typeof EvalDecompositionBenchmarkCase.Type;

export const EvalDecompositionBenchmark = Schema.Struct({
  maximumVectorL1Error: Schema.Finite,
  cases: Schema.Array(EvalDecompositionBenchmarkCase)
});
export type EvalDecompositionBenchmark = typeof EvalDecompositionBenchmark.Type;

export const EvalCompositionCase = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  context: Schema.optionalKey(Schema.String),
  rubric: Schema.String,
  decomposition: DecompositionResult,
  requirements: RequestRoutingRequirements
});
export type EvalCompositionCase = typeof EvalCompositionCase.Type;

export const EvalCompositionSuite = Schema.Struct({
  maximumOutputTokens: NonNegativeInteger,
  minimumWinnerScoreGap: Schema.Finite,
  minimumWinnerAgreement: Schema.Finite,
  cases: Schema.Array(EvalCompositionCase)
});
export type EvalCompositionSuite = typeof EvalCompositionSuite.Type;

export const EvalEvaluationProposal = Schema.Struct({
  version: Schema.Literal(EVAL_PROJECT_VERSION),
  evaluationDigest: Schema.String,
  basisDigest: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  judgeModel: Schema.String,
  suites: Schema.Array(EvalDimensionSuite),
  decompositionBenchmark: EvalDecompositionBenchmark,
  compositionSuite: EvalCompositionSuite
});
export type EvalEvaluationProposal = typeof EvalEvaluationProposal.Type;

export const EvalArtifactApproval = Schema.Struct({
  version: Schema.Literal(EVAL_PROJECT_VERSION),
  kind: Schema.Literals(["routing-basis", "evaluations"]),
  digest: Schema.String,
  approvedAt: Schema.String
});
export type EvalArtifactApproval = typeof EvalArtifactApproval.Type;

export const EvalPlanScope = Schema.Literals(["pilot", "full"]);
export type EvalPlanScope = typeof EvalPlanScope.Type;

export const EvalExecutionPlan = Schema.Struct({
  version: Schema.Literal(EVAL_PROJECT_VERSION),
  planId: Schema.String,
  projectId: Schema.String,
  projectRevision: NonNegativeInteger,
  createdAt: Schema.String,
  scope: EvalPlanScope,
  basisDigest: Schema.String,
  evaluationDigest: Schema.String,
  candidateModels: Schema.Array(Schema.String),
  classifierModel: Schema.String,
  authorModel: Schema.String,
  judgeModel: Schema.String,
  selectedCaseIds: Schema.Array(
    Schema.Struct({
      dimensionId: Schema.String,
      caseIds: Schema.Array(Schema.String)
    })
  ),
  selectedDecompositionCaseIds: Schema.Array(Schema.String),
  selectedCompositionCaseIds: Schema.Array(Schema.String),
  maximumOutputTokens: NonNegativeInteger,
  expectedDimensionCandidateCalls: NonNegativeInteger,
  expectedDimensionJudgeCalls: NonNegativeInteger,
  expectedClassifierCalls: NonNegativeInteger,
  expectedCompositionCandidateCalls: NonNegativeInteger,
  expectedCompositionJudgeCalls: NonNegativeInteger,
  expectedCandidateCalls: NonNegativeInteger,
  expectedJudgeCalls: NonNegativeInteger,
  expectedCallCount: NonNegativeInteger
});
export type EvalExecutionPlan = typeof EvalExecutionPlan.Type;

export const EvalRunTarget = Schema.Struct({
  kind: Schema.Literals(["configured", "external"]),
  identity: Schema.String,
  publishAllowed: Schema.Boolean
});
export type EvalRunTarget = typeof EvalRunTarget.Type;

export const EvalRunCleanup = Schema.Struct({
  sessionOpened: Schema.Boolean,
  sessionClosed: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String)
});
export type EvalRunCleanup = typeof EvalRunCleanup.Type;

export const EvalRunLedger = Schema.Struct({
  expectedCalls: NonNegativeInteger,
  observedCalls: NonNegativeInteger,
  observedCandidateRows: NonNegativeInteger,
  knownInputTokens: NonNegativeInteger,
  knownOutputTokens: NonNegativeInteger,
  unknownTokenMeasurements: NonNegativeInteger,
  knownPricedSubtotalUsd: NonNegativeFinite,
  unpricedCalls: NonNegativeInteger
});
export type EvalRunLedger = typeof EvalRunLedger.Type;

export const EvalClassifierObservation = Schema.Struct({
  caseId: Schema.String,
  weights: DecompositionResult.fields.weights,
  unknownWeight: DecompositionResult.fields.unknownWeight,
  vectorL1Error: NonNegativeFinite,
  passed: Schema.Boolean,
  classifierCallId: Schema.optionalKey(Schema.String),
  measurement: Schema.Struct({
    costUsd: Schema.optionalKey(NonNegativeFinite),
    durationMs: Schema.optionalKey(NonNegativeFinite),
    inputTokens: Schema.optionalKey(NonNegativeInteger),
    outputTokens: Schema.optionalKey(NonNegativeInteger)
  })
});
export type EvalClassifierObservation = typeof EvalClassifierObservation.Type;

export const EvalCompositionCaseResult = Schema.Struct({
  caseId: Schema.String,
  predictedWinner: Schema.String,
  observedWinner: Schema.String,
  predictedScoreGap: NonNegativeFinite,
  observedScoreGap: NonNegativeFinite,
  passed: Schema.Boolean
});
export type EvalCompositionCaseResult = typeof EvalCompositionCaseResult.Type;

export const EvalRunQualification = Schema.Struct({
  decomposition: Schema.Struct({
    expectedCases: NonNegativeInteger,
    passedCases: NonNegativeInteger,
    maximumObservedL1Error: NonNegativeFinite,
    observations: Schema.Array(EvalClassifierObservation)
  }),
  composition: Schema.Struct({
    expectedCases: NonNegativeInteger,
    comparableCases: NonNegativeInteger,
    agreeingCases: NonNegativeInteger,
    winnerAgreement: NonNegativeFinite,
    cases: Schema.Array(EvalCompositionCaseResult)
  })
});
export type EvalRunQualification = typeof EvalRunQualification.Type;

export function summarizeEvalRunLedger(
  comparisons: readonly EvalComparisonResultType[],
  expectedCalls: number,
  classifierObservations: readonly EvalClassifierObservation[] = []
): EvalRunLedger {
  let observedCalls = 0;
  let observedCandidateRows = 0;
  let knownInputTokens = 0;
  let knownOutputTokens = 0;
  let unknownTokenMeasurements = 0;
  let knownPricedSubtotalUsd = 0;
  let unpricedCalls = 0;
  for (const comparison of comparisons) {
    const calls =
      comparison.calls ??
      comparison.models.flatMap((model) =>
        model.cases.map((testCase) => ({
          role: "candidate" as const,
          model: model.model,
          caseId: testCase.caseId,
          measurement: testCase.measurement
        }))
      );
    for (const call of calls) {
      observedCalls += 1;
      if (call.role === "candidate") observedCandidateRows += 1;
      if (
        call.measurement.inputTokens === undefined ||
        call.measurement.outputTokens === undefined
      ) {
        unknownTokenMeasurements += 1;
      } else {
        knownInputTokens += call.measurement.inputTokens;
        knownOutputTokens += call.measurement.outputTokens;
      }
      if (call.measurement.costUsd === undefined) {
        unpricedCalls += 1;
      } else {
        knownPricedSubtotalUsd += call.measurement.costUsd;
      }
    }
  }
  for (const observation of classifierObservations) {
    observedCalls += 1;
    if (
      observation.measurement.inputTokens === undefined ||
      observation.measurement.outputTokens === undefined
    ) {
      unknownTokenMeasurements += 1;
    } else {
      knownInputTokens += observation.measurement.inputTokens;
      knownOutputTokens += observation.measurement.outputTokens;
    }
    if (observation.measurement.costUsd === undefined) {
      unpricedCalls += 1;
    } else {
      knownPricedSubtotalUsd += observation.measurement.costUsd;
    }
  }
  return {
    expectedCalls,
    observedCalls,
    observedCandidateRows,
    knownInputTokens,
    knownOutputTokens,
    unknownTokenMeasurements,
    knownPricedSubtotalUsd,
    unpricedCalls
  };
}

const EvalRunReportCommon = {
  version: Schema.Literal(EVAL_PROJECT_VERSION),
  runId: Schema.String,
  planId: Schema.String,
  projectId: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  basisDigest: Schema.String,
  evaluationDigest: Schema.String,
  target: EvalRunTarget,
  cleanup: EvalRunCleanup,
  comparisons: Schema.Array(EvalComparisonResult),
  qualification: Schema.optionalKey(EvalRunQualification),
  ledger: EvalRunLedger
} as const;

export const EvalRunFailureError = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String)
});
export type EvalRunFailureError = typeof EvalRunFailureError.Type;

const QualifiedEvalRunReport = Schema.Struct({
  ...EvalRunReportCommon,
  status: Schema.Literal("passed"),
  activation: PublishedRoutingActivation
});

const CompletedEvalRunReport = Schema.Struct({
  ...EvalRunReportCommon,
  status: Schema.Literal("completed"),
  activation: PublishedRoutingActivation
});

const FailedEvalRunReport = Schema.Struct({
  ...EvalRunReportCommon,
  status: Schema.Literal("failed"),
  failure: Schema.String,
  errors: Schema.optionalKey(Schema.Array(EvalRunFailureError))
});

/**
 * Sanitized durable result of one immutable execution plan.
 *
 * Prompts, model responses, credentials, headers, and raw child output are
 * deliberately absent from this contract. Dollar totals are known-priced
 * subtotals only; callers must render cost as unknown when
 * `unpricedCalls` is non-zero.
 */
export const EvalRunReport = Schema.Union([
  QualifiedEvalRunReport,
  CompletedEvalRunReport,
  FailedEvalRunReport
]);
export type EvalRunReport = typeof EvalRunReport.Type;

export type EvalProjectArtifactsStatus = {
  readonly basisProposalDigest?: string;
  readonly basisApproved: boolean;
  readonly evaluationProposalDigest?: string;
  readonly evaluationsApproved: boolean;
  readonly plans: readonly string[];
};

export type EvalProjectStatus = {
  readonly state: EvalProjectState;
  readonly question?: EvalProjectQuestion;
  readonly artifacts?: EvalProjectArtifactsStatus;
  readonly nextAction:
    | "answer"
    | "propose-dimensions"
    | "approve-dimensions"
    | "propose-evaluations"
    | "approve-evaluations"
    | "run"
    | "publish"
    | "none";
};
