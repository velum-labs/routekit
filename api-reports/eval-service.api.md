# @velum-labs/routekit-eval-service

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `ca279203b590ff54261e49698d7215bb16c7cb6a3b3ca3ef790eac9e1c7e39c6`

## Root declarations

```ts
export type { CompletedOriLibraryResult, OriArtifactPromotionInput, OriPolicyHandoffInput, OriPolicyHandoffResult, OriStructuredEvalRun, PromotedOriEvalArtifacts, ResolvedOriEvalRun } from "./ori-artifact-promotion.js";
export type { EvalComparisonMode, EvalComparisonRunnerShape, EvalRunConfiguration, EvalServiceConfiguration, EvalServiceError, EvalServiceShape } from "./service.js";
export type { RouteKitEvalComparisonRunnerOptions, RouteKitEvalSetupLayerOptions } from "./production-runner.js";
export { EvalComparisonRunner, EvalService, makeEvalService, makeEvalServiceLayer } from "./service.js";
export { EvalComparisonRunnerCredentialError, makeEvalComparisonRunner, makeEvalComparisonRunnerLayer, makeRouteKitEvalSetupLayer } from "./production-runner.js";
export { EvalServiceComparisonError, EvalServiceConfigurationError, EvalServiceEstimateError, EvalServicePolicyError, EvalServicePublicationError, EvalServiceValidationError } from "./errors.js";
export { OriArtifactPromotionError, OriPolicyHandoffError, promoteOriEvalArtifacts, publishOriEvalPolicyHandoff, selectLatestSuccessfulOriEvalRun } from "./ori-artifact-promotion.js";
export { makeOriEvalSetupLayer } from "./ori-setup-layer.js";
```
