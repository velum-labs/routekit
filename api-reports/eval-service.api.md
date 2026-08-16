# @velum-labs/routekit-eval-service

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7f6b1caec0f24c2e894672f75316d098c0d3fc09b35ca4d0a9e36751655d9508`

## Root declarations

```ts
export type { CompletedOriLibraryResult, OriArtifactPromotionInput, OriAuthoredArtifactPromotionInput, OriPolicyHandoffInput, OriPolicyHandoffResult, OriStructuredEvalRun, PromotedOriAuthoredArtifacts, PromotedOriEvalArtifacts, ResolvedOriEvalRun } from "./ori-artifact-promotion.js";
export type { EvalComparisonMode, EvalComparisonRunnerShape, EvalRunConfiguration, EvalServiceConfiguration, EvalServiceError, EvalServiceShape } from "./service.js";
export type { RouteKitEvalComparisonRunnerOptions, RouteKitEvalSetupLayerOptions } from "./production-runner.js";
export { EvalComparisonRunner, EvalService, makeEvalService, makeEvalServiceLayer } from "./service.js";
export { EvalComparisonRunnerCredentialError, makeEvalComparisonRunner, makeEvalComparisonRunnerLayer, makeRouteKitEvalSetupLayer } from "./production-runner.js";
export { EvalServiceComparisonError, EvalServiceConfigurationError, EvalServiceEstimateError, EvalServicePolicyError, EvalServicePublicationError, EvalServiceValidationError } from "./errors.js";
export { OriArtifactPromotionError, OriPolicyHandoffError, promoteOriAuthoredArtifacts, promoteOriEvalArtifacts, publishOriEvalPolicyHandoff, selectLatestSuccessfulOriEvalRun } from "./ori-artifact-promotion.js";
export { executeOriAuthoredProfile, OriAuthoredProfileExecutionError } from "./authored-profile-executor.js";
export { makeOriEvalSetupLayer } from "./ori-setup-layer.js";
```
