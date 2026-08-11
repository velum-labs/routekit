# @velum-labs/routekit-gateway/routing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `0972c8bbcbed77e21b070a46e9bc926225be5d06b5d41a2817767d63519a328e`

## Root declarations

```ts
export type { CatalogModelInfo, RoutingBackendOptions } from "./router.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing-core.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./router.js";
```
