# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `63204869ce41e5162e156dd5946dcfd78175d4a1016fb9ca08070b4d19b4fd5f`

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
export { makeRouteKitRuntime, RouteKitLive, runRouteKitEffect, runRouteKitEffectExit, sharedRouteKitRuntime } from "./effect/effect-runtime.js";
export { makeSingleFlight } from "./effect/single-flight.js";
export { superviseSpawnEffect } from "./effect/process-supervisor.js";
export { withAbortSignal } from "./effect/abort-signal.js";
```
