export { extendCleanupGrace, registerCleanup, runCleanups } from "./lifecycle/cleanup.js";
export type {
  OwnedResourceOptions,
  ResourceFinalizer,
  ResourceOwnership,
  ResourceScopeOptions
} from "./lifecycle/resource-scope.js";
export { ResourceDisposalTimeoutError, ResourceScope } from "./lifecycle/resource-scope.js";
