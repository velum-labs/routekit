# @velum-labs/routekit-eval-core/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `8a6549e0482656af4c1313e4cfd8d2f74f372821ca7d7e9e80bd505a5c7c7af0`

## Root declarations

```ts
export type { EvalEgressOptions } from "./egress.js";
export { aggregateEvalResults, runEvalSuite } from "./run.js";
export { canonicalJson, configurationValue, expectedExperimentCost, freezeExperimentPlan, hashExperimentValue, requiredExperimentApprovalStages, sha256 } from "./experiment-plan.js";
export { evaluateClassificationPredictions, extractClassificationPrediction, renderClassificationMetrics, type ClassificationPredictionDefaults, type ClassificationTreatmentMetrics, type LabeledClassificationPrediction, type ProportionMetric } from "./classification-metrics.js";
export { renderExperimentReport, summarizeExperimentJobs } from "./experiment-report.js";
```
