# @velum-labs/routekit-eval-store

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `e1d61c97117cf9d765a34a6c350e4006c774039eea1cf145c503da4b6918c395`

## Root declarations

```ts
export { EXPERIMENT_JOB_MAXIMUM_ATTEMPTS, LocalExperimentLedger, type CompleteExperimentJobInput, type ExperimentLedger, type FailExperimentJobInput } from "./experiment-ledger.js";
export { EvalStore, makeEvalStore } from "./store.js";
export { LocalArtifactStore, VercelBlobArtifactStore, putJsonArtifact, readJsonArtifact, type ArtifactPutOptions, type ArtifactStore, type VercelBlobArtifactStoreOptions } from "./artifacts.js";
```
