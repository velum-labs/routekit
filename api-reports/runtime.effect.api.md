# @velum-labs/routekit-runtime/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `9b493490ab6ccc483a374d9e4b79a0cbfffe81e32d63d083dd161d9122d3f085`

## Root declarations

```ts
export type { EffectFileLock } from "./effect/files.js";
export type { RouteKitManagedRuntime, RouteKitPlatform } from "./effect/effect-runtime.js";
export type { SingleFlight } from "./effect/single-flight.js";
export { CapacityPool } from "./capacity-pool.js";
export { CapacityPoolExhausted, DuplicateCapacityMember, EmptyCapacityPool, InvalidDocumentVersion, RouteKitFailure, routeKitError, throwRouteKitExit, UnknownCapacityMember } from "./effect/errors.js";
export { EffectResourceScope, makeEffectResourceScope } from "./effect/resource-scope.js";
export { EffectVersionedDocumentStore, makeEffectDocumentStore } from "./effect/document-store.js";
export { ensureRunOutputDirEffect, tryAcquireFileLockEffect, writeFileAtomicEffect } from "./effect/files.js";
export { executeWebRequest, fetchResponseFromClient, fetchViaHttpClient } from "./effect/http.js";
export { extendCleanupGraceEffect, registerCleanupEffect, runCleanupsEffect } from "./effect/cleanup.js";
export { makeRouteKitRuntime, RouteKitLive, runRouteKitEffect, runRouteKitEffectExit, sharedRouteKitRuntime } from "./effect/effect-runtime.js";
export { makeSingleFlight } from "./effect/single-flight.js";
export { superviseSpawnEffect } from "./effect/process-supervisor.js";
export { withAbortSignal } from "./effect/abort-signal.js";
```
