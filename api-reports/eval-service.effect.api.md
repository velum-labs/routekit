# @velum-labs/routekit-eval-service/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `72886d4ddb7065736defd6bf0c9143feba976b4b2287043a4a4363d987aba1a0`

## Root declarations

```ts
export type { EvalComparisonMode, EvalComparisonRunnerShape, EvalRunConfiguration, EvalServiceConfiguration, EvalServiceError, EvalServiceShape } from "./service.js";
export type { RouteKitEvalComparisonRunnerOptions, RouteKitEvalSetupLayerOptions } from "./production-runner.js";
export { EvalComparisonRunner, EvalService, EvalSetupRunnerFromEvalService, makeEvalService, makeEvalServiceLayer } from "./service.js";
export { EvalComparisonRunnerCredentialError, makeEvalComparisonRunner, makeEvalComparisonRunnerLayer, makeRouteKitEvalSetupLayer } from "./production-runner.js";
export { EvalServiceComparisonError, EvalServiceConfigurationError, EvalServiceEstimateError, EvalServicePolicyError, EvalServicePublicationError, EvalServiceValidationError } from "./errors.js";
```
