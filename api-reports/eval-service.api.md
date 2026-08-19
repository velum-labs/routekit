# @velum-labs/routekit-eval-service

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `4f8da3076edf9c4ab5041b300594088fb914f3043b0f09c3c85b5390866f3755`

## Root declarations

```ts
export type { CompileDimensionEvidenceMatrixInput, CompiledDimensionEvidenceMatrix, DimensionComparisonEvidenceInput } from "./dimension-evidence.js";
export type { DimensionMatrixQualificationInput, DimensionMatrixQualificationResult, DimensionMatrixSuite, EvalComparisonEstimate, EvalComparisonMode, EvalRunConfiguration, EvalServiceConfiguration, EvalServiceError, EvalServiceShape, EvalSuiteInspection } from "./service.js";
export type { RouteKitEvalServiceOptions } from "./production-runner.js";
export { EvalService } from "./service.js";
export { EvalServiceComparisonError, EvalServiceConfigurationError, EvalServiceEstimateError, EvalServicePolicyError, EvalServicePublicationError, EvalServiceSpendLimitError, EvalServiceValidationError } from "./errors.js";
export { EvalServiceCredentialError, makeRouteKitEvalServiceLayer } from "./production-runner.js";
export { compileDimensionEvidenceMatrix, DimensionEvidenceCompilationError, wilsonLowerBound95 } from "./dimension-evidence.js";
```
