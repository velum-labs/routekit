# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `d207a570a47ee913f3614ca205ffc676e774d767a10d7e2381cb296cded7a343`

## Root declarations

```ts
export type { EffectFileLock } from "./filesystem/effect-files.js";
export type { NodeHttpHandler } from "./network/node-http.js";
export type { RouteKitManagedRuntime, RouteKitPlatform } from "./effect/effect-runtime.js";
export type { SingleFlight } from "./lifecycle/single-flight.js";
export { CapacityPool } from "./capacity-pool.js";
export { CapacityPoolExhausted, DuplicateCapacityMember, EmptyCapacityPool, InvalidDocumentVersion, RouteKitFailure, routeKitError, throwRouteKitExit, toRouteKitFailure, UnknownCapacityMember } from "./effect/errors.js";
export { EffectVersionedDocumentStore, makeEffectDocumentStore } from "./filesystem/effect-document-store.js";
export { createNodeHttpHandler, createNodeHttpHandlerEffect } from "./network/node-http.js";
export { ensureRunOutputDirEffect, tryAcquireFileLockEffect, writeFileAtomicEffect } from "./filesystem/effect-files.js";
export { executeWebRequest, fetchResponseFromClient } from "./network/http.js";
export { extendCleanupGraceEffect, registerCleanupEffect, runCleanupsEffect } from "./lifecycle/effect-cleanup.js";
export { makeRouteKitRuntime, RouteKitLive, runRouteKitEffect, runRouteKitEffectExit, runRouteKitEffectWith, sharedRouteKitRuntime } from "./effect/effect-runtime.js";
export { makeSingleFlight } from "./lifecycle/single-flight.js";
export { startControlServerEffect } from "./control-server-service.js";
export { superviseSpawnEffect } from "./process/supervisor.js";
export { withAbortSignal } from "./lifecycle/abort-signal.js";
```
