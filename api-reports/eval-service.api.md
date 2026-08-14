# @velum-labs/routekit-eval-service

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7865a6562d270079bf192644ade1b5a0edf0684d93cd5e8988849c743cc622a7`

## Root declarations

```ts
export type { EvalApplicationError, EvalExecutionInput, EvalPathOptions, EvalServiceApi, EvalServiceConfig, EvalServiceEvent, EvalWorkload } from "./service.js";
export type { EvalRepositoryFailure, EvalRepositoryReadFailure, EvalRepositoryService, PersistedEvalRun } from "./repository.js";
export { EvalRepository, EvalRepositoryError, EvalRunImmutableError, InvalidEvalRunIdError, isValidEvalRunId, validateEvalRunId, makeEvalRepositoryLayer } from "./repository.js";
export { discoverEvalPath, dryRunEvalPath, EvalService, EvalServiceError, listEvalPath, makeEvalServiceLayer, runEvalPath } from "./service.js";
```
