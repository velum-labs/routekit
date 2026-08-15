# @velum-labs/routekit-eval-engine

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `04993aba00d9ad358ca2fabebf1f16326232a0ac4fad1ffb75799f6460e9c0bc`

## Root declarations

```ts
export * from "./full-api.js";
export type { EvalDiscovery, EvalDryRunSummary, EvalEngineError, EvalEngineEvent, EvalEngineOptions, EvalExecutionOptions, EvalHostMetadata, EvalResultLine, EvalResultRow, EvalRunLine, EvalRunOutcome, EvalRunOutcomeLine, EvalRunRole, EvalRunStartLine, EvalRunSummary, EvalTargetOptions, EvalTerminalEvent, EvalTestRow, EvalTestStatus, EvalUsage } from "./model.js";
export type { EvalEngineService } from "./engine.js";
export { EVAL_RESULTS_FILE_ENV } from "./routekit-eval/node-test.js";
export { EvalDiscoveryError, EvalDryRunError, EvalImportError, EvalResultReadError, EvalSpawnError } from "./model.js";
export { decodeResultLine, joinOutcomes } from "./routekit-eval/results-lines.js";
export { discoverEvals, dryRunEvals, EvalEngine, listEvals, makeEvalEngineLayer, runEvals } from "./engine.js";
export { nonPortableImportSpecifiers } from "./routekit-eval/portable-imports.js";
export { renderEvalReport } from "./report.js";
```
