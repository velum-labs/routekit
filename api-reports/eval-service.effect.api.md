# @velum-labs/routekit-eval-service/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `93c5e3b8b7a578f3e6f19f2ea4274655df98d7106d375b6ab3c73131a4b8560d`

## Root declarations

```ts
export type { CompileDimensionEvidenceMatrixInput, CompiledDimensionEvidenceMatrix, DimensionComparisonEvidenceInput } from "./dimension-evidence.js";
export type { DimensionMatrixQualificationInput, DimensionMatrixQualificationResult, DimensionMatrixSuite, EvalComparisonEstimate, EvalComparisonMode, EvalRunConfiguration, EvalServiceConfiguration, EvalServiceError, EvalServiceShape, EvalSuiteInspection } from "./service.js";
export type { RouteKitEvalGatewayCallEvent, RouteKitEvalServiceOptions } from "./production-runner.js";
export { EvalService } from "./service.js";
export { EvalServiceComparisonError, EvalServiceConfigurationError, EvalServiceEstimateError, EvalServicePolicyError, EvalServicePublicationError, EvalServiceSpendLimitError, EvalServiceValidationError } from "./errors.js";
export { EvalServiceCredentialError, makeRouteKitEvalServiceLayer } from "./production-runner.js";
export { compileDimensionEvidenceMatrix, DimensionEvidenceCompilationError, wilsonLowerBound95 } from "./dimension-evidence.js";
```
