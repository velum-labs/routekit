# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `4f43b9b43321b11aca6d6b585558188b2c7b9ddc525d7bb9dc2656d4f6cf7a5f`

## Root declarations

```ts
export type { EffectFileLock } from "./effect/files.js";
export type { NodeHttpHandler } from "./effect/node-http.js";
export type { RouteKitManagedRuntime, RouteKitPlatform } from "./effect/effect-runtime.js";
export type { SingleFlight } from "./effect/single-flight.js";
export { CapacityPool } from "./capacity-pool.js";
export { CapacityPoolExhausted, DuplicateCapacityMember, EmptyCapacityPool, InvalidDocumentVersion, RouteKitFailure, routeKitError, throwRouteKitExit, toRouteKitFailure, UnknownCapacityMember } from "./effect/errors.js";
export { EffectResourceScope, makeEffectResourceScope } from "./effect/resource-scope.js";
export { EffectVersionedDocumentStore, makeEffectDocumentStore } from "./effect/document-store.js";
export { createNodeHttpHandler } from "./effect/node-http.js";
export { ensureRunOutputDirEffect, tryAcquireFileLockEffect, writeFileAtomicEffect } from "./effect/files.js";
export { executeWebRequest, fetchResponseFromClient } from "./effect/http.js";
export { extendCleanupGraceEffect, registerCleanupEffect, runCleanupsEffect } from "./effect/cleanup.js";
export { makeRouteKitRuntime, RouteKitLive, runRouteKitEffect, runRouteKitEffectExit, runRouteKitEffectWith, sharedRouteKitRuntime } from "./effect/effect-runtime.js";
export { makeSingleFlight } from "./effect/single-flight.js";
export { superviseSpawnEffect } from "./effect/process-supervisor.js";
export { withAbortSignal } from "./effect/abort-signal.js";
```
