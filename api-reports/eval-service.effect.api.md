# @velum-labs/routekit-eval-service/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `fb886a908d64dc36857ab33cc315bf6a4d0eb63e21e22da74f3aab7e52cd7247`

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
