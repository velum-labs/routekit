# @velum-labs/routekit-eval-core/experiment

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `946912bca67ed946599c1e2272db2b77052456548c9f4c43d8002c4a2f675bd1`

## Root declarations

```ts
export { LocalExecutionBackend, type ExecutionBackend, type ExperimentExecutionContext, type ExperimentExecutionResult, type LocalExecutionBackendOptions } from "./execution.js";
export { canonicalJson, configurationValue, expectedExperimentCost, freezeExperimentPlan, hashExperimentValue, requiredExperimentApprovalStages, sha256 } from "./experiment-plan.js";
export { evaluateClassificationPredictions, extractClassificationPrediction, renderClassificationMetrics, type ClassificationPredictionDefaults, type ClassificationTreatmentMetrics, type LabeledClassificationPrediction, type ProportionMetric } from "./classification-metrics.js";
export { renderExperimentReport, summarizeExperimentJobs } from "./experiment-report.js";
```
