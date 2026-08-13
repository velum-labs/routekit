# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `33ccf4a84bd1aa14079365700a271639835ba24d20fa172fe96c770d53bb6c18`

## Root declarations

```ts
export type { EffectFileLock } from "./effect/files.js";
export type { RouteKitManagedRuntime, RouteKitPlatform } from "./effect/effect-runtime.js";
export type { SingleFlight } from "./effect/single-flight.js";
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
