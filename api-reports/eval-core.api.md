# @velum-labs/routekit-eval-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `fe221fd0416a8fa64d0877e995ac07c0d64f865cad8962aa45eaa35cd3feb7d8`

## Root declarations

```ts
export type { EvalEgressOptions } from "./egress.js";
export { LocalExecutionBackend, type ExecutionBackend, type ExperimentExecutionContext, type ExperimentExecutionResult, type LocalExecutionBackendOptions } from "./execution.js";
export { aggregateEvalResults, runEvalSuite } from "./run.js";
export { canonicalJson, configurationValue, expectedExperimentCost, freezeExperimentPlan, hashExperimentValue, requiredExperimentApprovalStages, sha256 } from "./experiment-plan.js";
export { evaluateClassificationPredictions, extractClassificationPrediction, renderClassificationMetrics, type ClassificationPredictionDefaults, type ClassificationTreatmentMetrics, type LabeledClassificationPrediction, type ProportionMetric } from "./classification-metrics.js";
export { renderExperimentReport, summarizeExperimentJobs } from "./experiment-report.js";
```
