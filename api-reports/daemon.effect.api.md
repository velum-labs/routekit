# @velum-labs/routekit-daemon/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a0adff0e9a5aee8050f74eae7ab527ecb517826b9403f35b432cfb70bb952c65`

## Root declarations

```ts
export { EffectCliproxySidecar, makeEffectCliproxySidecar, scopedCliproxySidecar } from "./effect/sidecar.js";
export { EffectDaemonGenerationManager, makeEffectDaemonGenerationManager } from "./effect/generations.js";
export { EffectDaemonRuntimeState, makeEffectDaemonRuntimeState } from "./effect/runtime-state.js";
export { EffectHostWorkerCoordinator, makeEffectHostWorkerCoordinator, runHostGenerationTransactionEffect, scopedHostWorkerSession } from "./effect/host-worker.js";
export { cleanupFailedDaemonEffect, createDaemonLifecycleEffect } from "./effect/lifecycle.js";
```
