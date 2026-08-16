# @velum-labs/routekit-eval-setup

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `bdf715d80ab70d20cb5a6d5e3009597904c030e036c7da056c873d89ef7f80b5`

## Root declarations

```ts
export type { EvalHostMetadata, HostEligibility } from "./host-metadata.js";
export type { EvalSetupError, EvalSetupShape } from "./service.js";
export type { EvalSetupRunCheckpoint, EvalSetupRunnerShape, RepositoryInspection, RepositoryMaterial, RepositorySurface, ScaffoldInput, ScaffoldResult, SetupAnswerResult, SetupEstimate, SetupQuestion, SetupRunResult, SetupStateView, SetupStatus } from "./types.js";
export type { OriEvalAuthoringApi, OriEvalResult } from "./ori-result.js";
export { EvalRepositoryInspector, EvalRepositoryInspectorLive, inspectRepository } from "./inspection.js";
export { EvalSetup, EvalSetupLive, makeEvalSetup } from "./service.js";
export { EvalSetupInspectionError, EvalSetupRunnerError, EvalSetupScaffoldError, EvalSetupStateError, EvalSetupTransitionError } from "./errors.js";
export { EvalSetupRunner, EvalSetupRunnerNoop } from "./runner.js";
export { EvalSetupScaffolder, EvalSetupScaffolderLive, scaffoldEvalRoutingProfile } from "./scaffold.js";
export { EvalSetupStateStore, EvalSetupStateStoreLive, initialSetupState, makeFileEvalSetupStateStore } from "./state-store.js";
export { OriEvalAuthoring, oriAuthoringFromApi } from "./ori-authoring.js";
export { authoringRequest, hostDirectory } from "./host-metadata.js";
export { questionForStage, withOpenQuestion } from "./questions.js";
```
