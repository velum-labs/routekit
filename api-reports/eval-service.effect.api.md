# @velum-labs/routekit-eval-service/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `171b559e1bc680ed51f3bee2f4559eb2b4e623fad3c37279cc347f8c35562020`

## Root declarations

```ts
export type { CompileDimensionEvidenceMatrixInput, CompiledDimensionEvidenceMatrix, DimensionComparisonEvidenceInput } from "./dimension-evidence.js";
export type { DimensionMatrixQualificationInput, DimensionMatrixQualificationResult, DimensionMatrixSuite, EvalComparisonEstimate, EvalComparisonMode, EvalComparisonRunnerShape, EvalRunConfiguration, EvalServiceConfiguration, EvalServiceError, EvalServiceShape, EvalSuiteInspection } from "./service.js";
export type { RouteKitEvalComparisonRunnerOptions } from "./production-runner.js";
export { EvalComparisonRunner, EvalService, makeEvalService, makeEvalServiceLayer } from "./service.js";
export { EvalComparisonRunnerCredentialError, EvalComparisonRunnerManifestError, makeEvalComparisonRunner, makeEvalComparisonRunnerLayer } from "./production-runner.js";
export { EvalServiceComparisonError, EvalServiceConfigurationError, EvalServicePolicyError, EvalServicePublicationError, EvalServiceValidationError } from "./errors.js";
export { compileDimensionEvidenceMatrix, DimensionEvidenceCompilationError, wilsonLowerBound95 } from "./dimension-evidence.js";
```
