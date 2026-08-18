# @velum-labs/routekit-gateway/routing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `d903fb7e5eb5541e90cb6159c15e3cf5da1195b435e99a8f01b9d818112f55ae`

## Root declarations

```ts
export type { CatalogModelInfo, RoutingBackendOptions } from "./routing/router.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing/core.js";
export type { ObservedDecompositionResult, RequestDecomposerService } from "./routing/classifier.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing/core.js";
export { CLASSIFIABLE_REQUEST_TEXT_LIMIT, ClassificationError, classifyRequestDimensions, extractClassifiableRequestText, makeFakeRequestDecomposer, makeLanguageModelDimensionClassifier, parseDecompositionResult, validateDecompositionInput, validateDecompositionResult } from "./routing/classifier.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./routing/router.js";
```
