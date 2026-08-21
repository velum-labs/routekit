# @velum-labs/routekit-eval-setup

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `eafee70b8f656c6a8d238897ea9507197cd1597445e783f8f94764413ef9866a`

## Root declarations

```ts
export type { EvalAuthoringCompletion, EvalAuthoringSource, EvalAuthoringTransportShape, EvalProjectAuthorShape } from "./project-authoring.js";
export type { EvalClassifierObservation, EvalCompositionCase, EvalCompositionCaseResult, EvalCompositionSuite, EvalDecompositionBenchmark, EvalDecompositionBenchmarkCase, EvalDimensionCase, EvalDimensionSuite, EvalEvaluationProposal, EvalExecutionPlan, EvalPlanScope, EvalProjectArtifactsStatus, EvalProjectStatus, EvalRunCleanup, EvalRunFailureError, EvalRunLedger, EvalRunQualification, EvalRunReport, EvalRunTarget } from "./project-contracts.js";
export type { EvalHostMetadata, HostEligibility } from "./host-metadata.js";
export type { EvalProjectWorkflowError, EvalProjectWorkflowShape } from "./project-workflow.js";
export type { EvalSetupError, EvalSetupShape } from "./service.js";
export type { EvalSetupRunCheckpoint, EvalSetupRunnerShape, RepositoryInspection, RepositoryMaterial, RepositorySurface, SetupAnswerResult, SetupEstimate, SetupQuestion, SetupRunResult, SetupStateView, SetupStatus } from "./types.js";
export type { OriEvalAuthoringApi, OriEvalResult } from "./ori-result.js";
export { EVAL_AUTHORING_CASES_PER_DIMENSION, EVAL_AUTHORING_EVALUATION_OUTPUT_TOKENS, EVAL_AUTHORING_REQUEST_BYTES, EVAL_AUTHORING_SOURCE_BYTES, EVAL_AUTHORING_SOURCE_FILES, EvalAuthoringTransport, EvalProjectAuthor, EvalProjectAuthorLive, makeEvalProjectAuthor, readProjectAuthoringSources, selectProjectAuthoringSourceFiles } from "./project-authoring.js";
export { EVAL_PROJECT_VERSION, EvalArtifactApproval, EvalCompositionSuite as EvalCompositionSuiteSchema, EvalDecompositionBenchmark as EvalDecompositionBenchmarkSchema, EvalDimensionCase as EvalDimensionCaseSchema, EvalDimensionSuite as EvalDimensionSuiteSchema, EvalEvaluationProposal as EvalEvaluationProposalSchema, EvalExecutionPlan as EvalExecutionPlanSchema, EvalPlanScope as EvalPlanScopeSchema, EvalProjectConfiguration, EvalProjectQuestion, EvalProjectSetupProgress, EvalProjectState, EvalRunCleanup as EvalRunCleanupSchema, EvalRunFailureError as EvalRunFailureErrorSchema, EvalRunLedger as EvalRunLedgerSchema, EvalRunReport as EvalRunReportSchema, EvalRunTarget as EvalRunTargetSchema, summarizeEvalRunLedger } from "./project-contracts.js";
export { EvalProjectArtifactError, EvalProjectAuthoringError, EvalProjectStoreError, EvalProjectTransitionError, EvalSetupInspectionError, EvalSetupRunnerError, EvalSetupScaffoldError, EvalSetupStateError, EvalSetupTransitionError } from "./errors.js";
export { EvalProjectArtifacts, EvalProjectArtifactsLive, evaluationProposalDigest, makeFileEvalProjectArtifacts, routingBasisDigest } from "./project-artifacts.js";
export { EvalProjectStore, EvalProjectStoreLive, makeFileEvalProjectStore } from "./project-store.js";
export { EvalProjectWorkflow, EvalProjectWorkflowLive, makeEvalProjectWorkflow } from "./project-workflow.js";
export { EvalRepositoryInspector, EvalRepositoryInspectorLive, inspectRepository } from "./inspection.js";
export { EvalSetup, EvalSetupLive, makeEvalSetup } from "./service.js";
export { EvalSetupRunner, EvalSetupRunnerNoop } from "./runner.js";
export { EvalSetupStateStore, EvalSetupStateStoreLive, initialSetupState, makeFileEvalSetupStateStore } from "./state-store.js";
export { OriEvalAuthoring, oriAuthoringFromApi } from "./ori-authoring.js";
export { authoringRequest, hostDirectory } from "./host-metadata.js";
export { questionForStage, withOpenQuestion } from "./questions.js";
```
