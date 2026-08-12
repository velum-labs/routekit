# @velum-labs/routekit-gateway/routing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `21cb01ef4d2eef74057fc0ebb3e43890d9158b190cd65330397c4cb93d613400`

## Root declarations

```ts
export type { CatalogModelInfo, RoutingBackendOptions } from "./router.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing-core.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./router.js";
```
