# @velum-labs/routekit-eval-setup/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `99f4b3e7888457ce0052b0c9ecb669d35ae4b2b7376bcba1a2abc94b90d489c8`

## Root declarations

```ts
export type { EvalAuthoringCompletion, EvalAuthoringSource, EvalAuthoringTransportShape, EvalProjectAuthorShape } from "./project-authoring.js";
export type { EvalProjectWorkflowError, EvalProjectWorkflowShape } from "./project-workflow.js";
export type { OriEvalAuthoringApi, OriEvalResult } from "./ori-result.js";
export { EvalAuthoringTransport, EvalProjectAuthor, EvalProjectAuthorLive, makeEvalProjectAuthor, readProjectAuthoringSources, selectProjectAuthoringSourceFiles } from "./project-authoring.js";
export { EvalProjectArtifacts, EvalProjectArtifactsLive, evaluationProposalDigest, makeFileEvalProjectArtifacts, routingBasisDigest } from "./project-artifacts.js";
export { EvalProjectStore, EvalProjectStoreLive, makeFileEvalProjectStore } from "./project-store.js";
export { EvalProjectWorkflow, EvalProjectWorkflowLive, makeEvalProjectWorkflow } from "./project-workflow.js";
export { EvalRepositoryInspector, EvalRepositoryInspectorLive, inspectRepository } from "./inspection.js";
export { EvalSetup, EvalSetupLive, makeEvalSetup } from "./service.js";
export { EvalSetupRunner, EvalSetupRunnerNoop } from "./runner.js";
export { EvalSetupScaffolder, EvalSetupScaffolderLive, scaffoldEvalRoutingProfile } from "./scaffold.js";
export { EvalSetupStateStore, EvalSetupStateStoreLive, initialSetupState, makeFileEvalSetupStateStore } from "./state-store.js";
export { OriEvalAuthoring, oriAuthoringFromApi } from "./ori-authoring.js";
```
