# @velum-labs/routekit-eval-setup

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `46507ab5c3a48c928d0d2af6bc44b0698dae549e83ddc07b4718fe45e1d6fafd`

## Root declarations

```ts
export type { EvalSetupError, EvalSetupShape } from "./service.js";
export type { EvalSetupRunnerShape, EvalSetupRunCheckpoint, RepositoryInspection, RepositoryMaterial, RepositorySurface, ScaffoldInput, ScaffoldResult, SetupAnswerResult, SetupEstimate, SetupQuestion, SetupRunResult, SetupStatus } from "./types.js";
export { EvalRepositoryInspector, EvalRepositoryInspectorLive, inspectRepository } from "./inspection.js";
export { EvalSetup, EvalSetupLive, makeEvalSetup } from "./service.js";
export { EvalSetupInspectionError, EvalSetupRunnerError, EvalSetupScaffoldError, EvalSetupStateError, EvalSetupTransitionError } from "./errors.js";
export { EvalSetupRunner, EvalSetupRunnerNoop } from "./runner.js";
export { EvalSetupScaffolder, EvalSetupScaffolderLive, scaffoldEvalRoutingProfile } from "./scaffold.js";
export { EvalSetupStateStore, EvalSetupStateStoreLive, initialSetupState, makeFileEvalSetupStateStore } from "./state-store.js";
export { questionForStage, withOpenQuestion } from "./questions.js";
```
