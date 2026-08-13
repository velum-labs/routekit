# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `e51770b98a5b409277a597bf9c4b08a9b24702e350714a9e2aad4bc6cac17b1b`

## Root declarations

```ts
export type { EffectFileLock } from "./effect/files.js";
export type { RouteKitManagedRuntime, RouteKitPlatform } from "./effect/effect-runtime.js";
export type { SingleFlight } from "./effect/single-flight.js";
export { EffectCapacityPool, makeEffectCapacityPool } from "./effect/capacity-pool.js";
export { EffectDocumentStore, makeEffectDocumentStore } from "./effect/document-store.js";
export { EffectResourceScope, makeEffectResourceScope } from "./effect/resource-scope.js";
export { ensureRunOutputDirEffect, tryAcquireFileLockEffect, writeFileAtomicEffect } from "./effect/files.js";
export { extendCleanupGraceEffect, registerCleanupEffect, runCleanupsEffect } from "./effect/cleanup.js";
export { makeRouteKitRuntime, runRouteKitEffect, runRouteKitEffectExit } from "./effect/effect-runtime.js";
export { makeSingleFlight } from "./effect/single-flight.js";
export { routeKitError, throwRouteKitExit } from "./effect/errors.js";
export { superviseSpawnEffect } from "./effect/process-supervisor.js";
export { withAbortSignal } from "./effect/abort-signal.js";
```
