# @velum-labs/routekit-runtime/lifecycle

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `402904052266fb7ca6e40ff12e3e99fd8897c3c20f95b98c9d469329d6e027be`

## Root declarations

```ts
export type { OwnedResourceOptions, ResourceFinalizer, ResourceOwnership, ResourceScopeOptions } from "./lifecycle/resource-scope.js";
export { ResourceDisposalTimeoutError, ResourceScope } from "./lifecycle/resource-scope.js";
export { extendCleanupGrace, registerCleanup, runCleanups } from "./lifecycle/cleanup.js";
```
