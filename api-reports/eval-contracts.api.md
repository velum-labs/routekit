# @velum-labs/routekit-eval-contracts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a3b3722827b67e30b7a6a47abed8ef9e899a932f60f72ff26fbe7469e4ee120b`

## Root declarations

```ts
export declare const CLASSIFIABLE_PROFILE_DESCRIPTION_LIMIT = 1024;
export declare const CLASSIFIABLE_PROFILE_EVIDENCE_LIMIT = 64;
export declare const CLASSIFIABLE_PROFILE_FALLBACK_LIMIT = 32;
export declare const CLASSIFIABLE_PROFILE_LIMIT = 64;
export declare const CLASSIFIER_CATALOG_TEXT_LIMIT: number;
export declare const ClassifiableProfile: Schema.Struct<{
export declare const ClassifiableProfileEvidence: Schema.Struct<{
export declare const ClassificationInput: Schema.Struct<{
export declare const ClassificationResult: Schema.Struct<{
export declare const ClassificationScore: Schema.Struct<{
export declare const CompiledRoutingPolicy: Schema.Struct<{
export declare const EVAL_ATTRIBUTION_HEADER = "x-routekit-eval-attribution";
export declare const EVAL_CONTRACT_VERSION: 1;
export declare const EVAL_FORBIDDEN_MODELS: readonly ["auto", "router", "default"];
export declare const EVAL_POLICY: EvalPolicy;
export declare const EVAL_POLICY_BYPASS_HEADER = "x-routekit-eval-policy-bypass";
export declare const EVAL_SETUP_VERSION: 1;
export declare const EvalAttribution: Schema.Struct<{
export declare const EvalCase: Schema.Struct<{
export declare const EvalCaseResult: Schema.Struct<{
export declare const EvalComparisonCase: Schema.Struct<{
export declare const EvalComparisonRequest: Schema.Struct<{
export declare const EvalComparisonResult: Schema.Struct<{
export declare const EvalContractVersion: Schema.Literal<1>;
export declare const EvalEvidence: Schema.Struct<{
export declare const EvalMeasurement: Schema.Struct<{
export declare const EvalModelComparison: Schema.Struct<{
export declare const EvalPolicy: Schema.Struct<{
export declare const EvalRole: Schema.Literals<readonly ["candidate", "judge"]>;
export declare const EvalRunResult: Schema.Struct<{
export declare const EvalSetupEvent: Schema.Union<readonly [Schema.Struct<{
export declare const EvalSetupRunMode: Schema.Literals<readonly ["pilot", "full", "save-only"]>;
export declare const EvalSetupStage: Schema.Literals<readonly ["surface", "data", "criteria", "constraints", "candidates", "spend-approval", "publish", "completed"]>;
export declare const EvalSetupState: Schema.Struct<{
export declare const EvalSuiteSpec: Schema.Struct<{
export declare const EvalWorkerRequest: Schema.Struct<{
export declare const EvalWorkerResponse: Schema.Union<readonly [Schema.Struct<{
export declare const ModelEvidence: Schema.Struct<{
export declare const PublishedRoutingProfile: Schema.Struct<{
export declare const PublishedRoutingSnapshot: Schema.Struct<{
export declare const ROUTEKIT_ROUTING_PROFILE_HEADER = "x-routekit-profile";
export declare const ROUTING_SNAPSHOT_VERSION: 1;
export declare const RoutingEligibility: Schema.Struct<{
export declare const RoutingObjective: Schema.Literals<readonly ["lowest-cost", "lowest-latency", "highest-quality"]>;
export declare const RoutingProfile: Schema.Struct<{
export declare const RoutingRejection: Schema.Struct<{
export declare function assertCompiledRoutingPolicy(policy: CompiledRoutingPolicy): void;
export declare function assertExplicitEvalModel(model: string, role: EvalRole): void;
export declare function assertPublishedRoutingCatalog(profiles: Readonly<Record<string, PublishedRoutingProfile>>): void;
export declare function assertRoutingProfile(profile: RoutingProfile): void;
export declare function isForbiddenEvalModel(model: string): boolean;
export type ClassifiableProfile = typeof ClassifiableProfile.Type;
export type ClassifiableProfileEvidence = typeof ClassifiableProfileEvidence.Type;
export type ClassificationInput = typeof ClassificationInput.Type;
export type ClassificationResult = typeof ClassificationResult.Type;
export type ClassificationScore = typeof ClassificationScore.Type;
export type CompiledRoutingPolicy = typeof CompiledRoutingPolicy.Type;
export type EvalAttribution = typeof EvalAttribution.Type;
export type EvalCase = typeof EvalCase.Type;
export type EvalCaseResult = typeof EvalCaseResult.Type;
export type EvalComparisonCase = typeof EvalComparisonCase.Type;
export type EvalComparisonRequest = typeof EvalComparisonRequest.Type;
export type EvalComparisonResult = typeof EvalComparisonResult.Type;
export type EvalContractVersion = typeof EvalContractVersion.Type;
export type EvalEvidence = typeof EvalEvidence.Type;
export type EvalMeasurement = typeof EvalMeasurement.Type;
export type EvalModelComparison = typeof EvalModelComparison.Type;
export type EvalPolicy = typeof EvalPolicy.Type;
export type EvalRole = typeof EvalRole.Type;
export type EvalRunResult = typeof EvalRunResult.Type;
export type EvalSetupEvent = typeof EvalSetupEvent.Type;
export type EvalSetupRunMode = typeof EvalSetupRunMode.Type;
export type EvalSetupStage = typeof EvalSetupStage.Type;
export type EvalSetupState = typeof EvalSetupState.Type;
export type EvalSuiteSpec = typeof EvalSuiteSpec.Type;
export type EvalWorkerRequest = typeof EvalWorkerRequest.Type;
export type EvalWorkerResponse = typeof EvalWorkerResponse.Type;
export type ModelEvidence = typeof ModelEvidence.Type;
export type PublishedRoutingProfile = typeof PublishedRoutingProfile.Type;
export type PublishedRoutingSnapshot = typeof PublishedRoutingSnapshot.Type;
export type RoutingEligibility = typeof RoutingEligibility.Type;
export type RoutingObjective = typeof RoutingObjective.Type;
export type RoutingProfile = typeof RoutingProfile.Type;
export type RoutingRejection = typeof RoutingRejection.Type;
```
