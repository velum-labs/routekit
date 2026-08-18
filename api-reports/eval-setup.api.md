# @velum-labs/routekit-eval-setup

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7e85706c7b4e5ac965de8166d4055df730d784cf9afade47609eb0780f86b27a`

## Root declarations

```ts
export type { EvalAuthoringCompletion, EvalAuthoringSource, EvalAuthoringTransportShape, EvalProjectAuthorShape } from "./project-authoring.js";
export type { EvalDimensionCase, EvalDimensionSuite, EvalDecompositionBenchmark, EvalDecompositionBenchmarkCase, EvalCompositionCase, EvalCompositionCaseResult, EvalCompositionSuite, EvalClassifierObservation, EvalEvaluationProposal, EvalExecutionPlan, EvalPlanScope, EvalProjectArtifactsStatus, EvalProjectStatus, EvalRunCleanup, EvalRunLedger, EvalRunReport, EvalRunQualification, EvalRunTarget } from "./project-contracts.js";
export type { EvalHostMetadata, HostEligibility } from "./host-metadata.js";
export type { EvalProjectWorkflowError, EvalProjectWorkflowShape } from "./project-workflow.js";
export type { EvalSetupError, EvalSetupShape } from "./service.js";
export type { EvalSetupRunCheckpoint, EvalSetupRunnerShape, RepositoryInspection, RepositoryMaterial, RepositorySurface, ScaffoldInput, ScaffoldResult, SetupAnswerResult, SetupEstimate, SetupQuestion, SetupRunResult, SetupStateView, SetupStatus } from "./types.js";
export type { OriEvalAuthoringApi, OriEvalResult } from "./ori-result.js";
export { EVAL_AUTHORING_CASES_PER_DIMENSION, EVAL_AUTHORING_REQUEST_BYTES, EVAL_AUTHORING_SOURCE_BYTES, EVAL_AUTHORING_SOURCE_FILES, EvalAuthoringTransport, EvalProjectAuthor, EvalProjectAuthorLive, makeEvalProjectAuthor, readProjectAuthoringSources, selectProjectAuthoringSourceFiles } from "./project-authoring.js";
export { EVAL_PROJECT_VERSION, EvalArtifactApproval, EvalDimensionCase as EvalDimensionCaseSchema, EvalDimensionSuite as EvalDimensionSuiteSchema, EvalDecompositionBenchmark as EvalDecompositionBenchmarkSchema, EvalCompositionSuite as EvalCompositionSuiteSchema, EvalEvaluationProposal as EvalEvaluationProposalSchema, EvalExecutionPlan as EvalExecutionPlanSchema, EvalPlanScope as EvalPlanScopeSchema, EvalProjectConfiguration, EvalProjectQuestion, EvalProjectSetupProgress, EvalProjectState, EvalRunCleanup as EvalRunCleanupSchema, EvalRunLedger as EvalRunLedgerSchema, EvalRunReport as EvalRunReportSchema, EvalRunTarget as EvalRunTargetSchema, summarizeEvalRunLedger } from "./project-contracts.js";
export { EvalProjectArtifactError, EvalProjectAuthoringError, EvalProjectStoreError, EvalProjectTransitionError, EvalSetupInspectionError, EvalSetupRunnerError, EvalSetupScaffoldError, EvalSetupStateError, EvalSetupTransitionError } from "./errors.js";
export { EvalProjectArtifacts, EvalProjectArtifactsLive, evaluationProposalDigest, makeFileEvalProjectArtifacts, routingBasisDigest } from "./project-artifacts.js";
export { EvalProjectStore, EvalProjectStoreLive, makeFileEvalProjectStore } from "./project-store.js";
export { EvalProjectWorkflow, EvalProjectWorkflowLive, makeEvalProjectWorkflow } from "./project-workflow.js";
export { EvalRepositoryInspector, EvalRepositoryInspectorLive, inspectRepository } from "./inspection.js";
export { EvalSetup, EvalSetupLive, makeEvalSetup } from "./service.js";
export { EvalSetupRunner, EvalSetupRunnerNoop } from "./runner.js";
export { EvalSetupScaffolder, EvalSetupScaffolderLive, scaffoldEvalRoutingProfile } from "./scaffold.js";
export { EvalSetupStateStore, EvalSetupStateStoreLive, initialSetupState, makeFileEvalSetupStateStore } from "./state-store.js";
export { OriEvalAuthoring, oriAuthoringFromApi } from "./ori-authoring.js";
export { authoringRequest, hostDirectory } from "./host-metadata.js";
export { questionForStage, withOpenQuestion } from "./questions.js";
```
