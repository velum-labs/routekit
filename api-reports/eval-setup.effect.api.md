# @velum-labs/routekit-eval-setup/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `cf1a1fa734098b6b4debb6bbe197a943fe125675bc79e3525c9bb97144b8c243`

## Root declarations

```ts
export type { OriEvalAuthoringApi, OriEvalResult } from "./ori-result.js";
export { EvalRepositoryInspector, EvalRepositoryInspectorLive, inspectRepository } from "./inspection.js";
export { EvalSetup, EvalSetupLive, makeEvalSetup } from "./service.js";
export { EvalSetupRunner, EvalSetupRunnerNoop } from "./runner.js";
export { EvalSetupScaffolder, EvalSetupScaffolderLive, scaffoldEvalRoutingProfile } from "./scaffold.js";
export { EvalSetupStateStore, EvalSetupStateStoreLive, initialSetupState, makeFileEvalSetupStateStore } from "./state-store.js";
export { OriEvalAuthoring, oriAuthoringFromApi } from "./ori-authoring.js";
```
