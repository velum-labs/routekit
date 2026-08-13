# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `cea8a8ce864a67bad4dc68a445a1234a244f4f8ad06caab8528f570cb8ae32ea`

## Root declarations

```ts
export type { EffectFileLock } from "./effect/files.js";
export type { RouteKitManagedRuntime, RouteKitPlatform } from "./effect/effect-runtime.js";
export type { SingleFlight } from "./effect/single-flight.js";
export { EffectCapacityPool, makeEffectCapacityPool } from "./effect/capacity-pool.js";
export { EffectDocumentStore, makeEffectDocumentStore } from "./effect/document-store.js";
export { EffectResourceScope, makeEffectResourceScope } from "./effect/resource-scope.js";
export { RouteKitFailure, routeKitError, throwRouteKitExit } from "./effect/errors.js";
export { ensureRunOutputDirEffect, tryAcquireFileLockEffect, writeFileAtomicEffect } from "./effect/files.js";
export { extendCleanupGraceEffect, registerCleanupEffect, runCleanupsEffect } from "./effect/cleanup.js";
export { makeRouteKitRuntime, runRouteKitEffect, runRouteKitEffectExit } from "./effect/effect-runtime.js";
export { makeSingleFlight } from "./effect/single-flight.js";
export { superviseSpawnEffect } from "./effect/process-supervisor.js";
export { withAbortSignal } from "./effect/abort-signal.js";
```
