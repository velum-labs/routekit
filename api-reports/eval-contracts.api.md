# @velum-labs/routekit-eval-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `6ed1ad63ba9e8b7e18f5ae4887fbb31e7c3f82e662f9f1dbe81d4a543701b4a9`

## Root declarations

```ts
export declare const AutoRoutingDecision: Schema.Struct<{
export declare const CLASSIFIABLE_PROFILE_DESCRIPTION_LIMIT = 1024;
export declare const CLASSIFIABLE_PROFILE_EVIDENCE_LIMIT = 64;
export declare const CLASSIFIABLE_PROFILE_FALLBACK_LIMIT = 32;
export declare const CLASSIFIABLE_PROFILE_LIMIT = 64;
export declare const CLASSIFIER_BASIS_TEXT_LIMIT: number;
export declare const COMPOSITIONAL_ROUTING_VERSION: 2;
export declare const CompiledRoutingPolicy: Schema.Struct<{
export declare const CompositionalRoutingVersion: Schema.Literal<2>;
export declare const DecompositionInput: Schema.Struct<{
export declare const DecompositionResult: Schema.Struct<{
export declare const DimensionWeight: Schema.Struct<{
export declare const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
export declare const EVAL_CONTRACT_VERSION: 1;
export declare const EVAL_FORBIDDEN_MODELS: readonly ["auto", "router", "default"];
export declare const EVAL_POLICY: EvalPolicy;
export declare const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
export declare const EVAL_SETUP_VERSION: 1;
export declare const EvalAttribution: Schema.Struct<{
export declare const EvalCase: Schema.Struct<{
export declare const EvalCaseResult: Schema.Struct<{
export declare const EvalComparisonCall: Schema.Struct<{
export declare const EvalComparisonCase: Schema.Struct<{
export declare const EvalComparisonRequest: Schema.Struct<{
export declare const EvalComparisonResult: Schema.Struct<{
export declare const EvalContractVersion: Schema.Literal<1>;
export declare const EvalEvidence: Schema.Struct<{
export declare const EvalMeasurement: Schema.Struct<{
export declare const EvalModelComparison: Schema.Struct<{
export declare const EvalPolicy: Schema.Struct<{
export declare const EvalRole: Schema.Literals<readonly ["author", "classifier", "candidate", "judge"]>;
export declare const EvalRunManifest: Schema.Struct<{
export declare const EvalRunResult: Schema.Struct<{
export declare const EvalSetupEvent: Schema.Union<readonly [Schema.Struct<{
export declare const EvalSetupRunMode: Schema.Literals<readonly ["pilot", "full", "save-only"]>;
export declare const EvalSetupStage: Schema.Literals<readonly ["surface", "data", "criteria", "constraints", "candidates", "spend-approval", "publish", "completed"]>;
export declare const EvalSetupState: Schema.Struct<{
export declare const EvalSuiteSpec: Schema.Struct<{
export declare const EvalWorkerRequest: Schema.Struct<{
export declare const EvalWorkerResponse: Schema.Union<readonly [Schema.Struct<{
export declare const ModelDimensionEvidence: Schema.Struct<{
export declare const ModelDimensionQuality: Schema.Struct<{
export declare const ModelEvidence: Schema.Struct<{
export declare const PublishedModelEvidenceSummary: Schema.Struct<{
export declare const PublishedRoutingActivation: Schema.Struct<{
export declare const PublishedRoutingProfile: Schema.Struct<{
export declare const PublishedRoutingSnapshot: Schema.Struct<{
export declare const REQUEST_DECOMPOSITION_TOLERANCE = 0.000001;
export declare const ROUTING_BASIS_DIMENSION_MAX = 10;
export declare const ROUTING_BASIS_DIMENSION_MIN = 5;
export declare const ROUTING_SNAPSHOT_VERSION: 1;
export declare const RequestDecomposition: Schema.Struct<{
export declare const RequestRoutingRequirements: Schema.Struct<{
export declare const RoutingActivationConstraints: Schema.Struct<{
export declare const RoutingBasis: Schema.Struct<{
export declare const RoutingCandidateDecision: Schema.Struct<{
export declare const RoutingEligibility: Schema.Struct<{
export declare const RoutingEndpoint: Schema.Literals<readonly ["chat", "responses", "anthropic"]>;
export declare const RoutingMetricWeights: Schema.Struct<{
export declare const RoutingObjective: Schema.Literals<readonly ["lowest-cost", "lowest-latency", "highest-quality"]>;
export declare const RoutingObjectivePolicy: Schema.Union<readonly [Schema.Struct<{
export declare const RoutingProfile: Schema.Struct<{
export declare const RoutingRejection: Schema.Struct<{
export declare const WORKLOAD_DIMENSION_BOUNDARY_LIMIT = 512;
export declare const WORKLOAD_DIMENSION_DESCRIPTION_LIMIT = 1024;
export declare const WorkloadDimension: Schema.Struct<{
export declare function assertAutoRoutingDecision(decision: AutoRoutingDecision, snapshot: PublishedRoutingActivation): void;
export declare function assertCompiledRoutingPolicy(policy: CompiledRoutingPolicy): void;
export declare function assertDecompositionInput(input: DecompositionInput): void;
export declare function assertDecompositionResult(result: DecompositionResult, basis: RoutingBasis): void;
export declare function assertExplicitEvalModel(model: string, role: EvalRole | "classifier" | "author"): void;
export declare function assertPublishedRoutingActivation(snapshot: PublishedRoutingActivation): void;
export declare function assertPublishedRoutingProfiles(profiles: Readonly<Record<string, PublishedRoutingProfile>>): void;
export declare function assertRequestDecomposition(decomposition: RequestDecomposition, basis: RoutingBasis): void;
export declare function assertRoutingBasis(basis: RoutingBasis): void;
export declare function assertRoutingObjectivePolicy(policy: RoutingObjectivePolicy): void;
export declare function assertRoutingProfile(profile: RoutingProfile): void;
export declare function isForbiddenEvalModel(model: string): boolean;
export type AutoRoutingDecision = typeof AutoRoutingDecision.Type;
export type CompiledRoutingPolicy = typeof CompiledRoutingPolicy.Type;
export type CompositionalRoutingVersion = typeof CompositionalRoutingVersion.Type;
export type DecompositionInput = typeof DecompositionInput.Type;
export type DecompositionResult = typeof DecompositionResult.Type;
export type DimensionWeight = typeof DimensionWeight.Type;
export type EvalAttribution = typeof EvalAttribution.Type;
export type EvalCase = typeof EvalCase.Type;
export type EvalCaseResult = typeof EvalCaseResult.Type;
export type EvalComparisonCall = typeof EvalComparisonCall.Type;
export type EvalComparisonCase = typeof EvalComparisonCase.Type;
export type EvalComparisonRequest = typeof EvalComparisonRequest.Type;
export type EvalComparisonResult = typeof EvalComparisonResult.Type;
export type EvalContractVersion = typeof EvalContractVersion.Type;
export type EvalEvidence = typeof EvalEvidence.Type;
export type EvalMeasurement = typeof EvalMeasurement.Type;
export type EvalModelComparison = typeof EvalModelComparison.Type;
export type EvalPolicy = typeof EvalPolicy.Type;
export type EvalRole = typeof EvalRole.Type;
export type EvalRunManifest = typeof EvalRunManifest.Type;
export type EvalRunResult = typeof EvalRunResult.Type;
export type EvalSetupEvent = typeof EvalSetupEvent.Type;
export type EvalSetupRunMode = typeof EvalSetupRunMode.Type;
export type EvalSetupStage = typeof EvalSetupStage.Type;
export type EvalSetupState = typeof EvalSetupState.Type;
export type EvalSuiteSpec = typeof EvalSuiteSpec.Type;
export type EvalWorkerRequest = typeof EvalWorkerRequest.Type;
export type EvalWorkerResponse = typeof EvalWorkerResponse.Type;
export type ModelDimensionEvidence = typeof ModelDimensionEvidence.Type;
export type ModelDimensionQuality = typeof ModelDimensionQuality.Type;
export type ModelEvidence = typeof ModelEvidence.Type;
export type PublishedModelEvidenceSummary = typeof PublishedModelEvidenceSummary.Type;
export type PublishedRoutingActivation = typeof PublishedRoutingActivation.Type;
export type PublishedRoutingProfile = typeof PublishedRoutingProfile.Type;
export type PublishedRoutingSnapshot = typeof PublishedRoutingSnapshot.Type;
export type RequestDecomposition = typeof RequestDecomposition.Type;
export type RequestRoutingRequirements = typeof RequestRoutingRequirements.Type;
export type RoutingActivationConstraints = typeof RoutingActivationConstraints.Type;
export type RoutingBasis = typeof RoutingBasis.Type;
export type RoutingCandidateDecision = typeof RoutingCandidateDecision.Type;
export type RoutingEligibility = typeof RoutingEligibility.Type;
export type RoutingEndpoint = typeof RoutingEndpoint.Type;
export type RoutingMetricWeights = typeof RoutingMetricWeights.Type;
export type RoutingObjective = typeof RoutingObjective.Type;
export type RoutingObjectivePolicy = typeof RoutingObjectivePolicy.Type;
export type RoutingProfile = typeof RoutingProfile.Type;
export type RoutingRejection = typeof RoutingRejection.Type;
export type WorkloadDimension = typeof WorkloadDimension.Type;
```
