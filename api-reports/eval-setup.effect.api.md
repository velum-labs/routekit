# @velum-labs/routekit-eval-setup/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `fb6648062296ef02c04891445911b0bca4c66ef51d0883ea89a4ca342e8c6aad`

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
