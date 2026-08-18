# @velum-labs/routekit-gateway/routing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `75c6d3569bc5137dfb7d171796f685f0301c989382c7bcde5b2afe44a560b0a1`

## Root declarations

```ts
export type { CatalogModelInfo, RoutingBackendOptions } from "./router.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
export type { ObservedDecompositionResult, RequestDecomposerService } from "./request-classifier.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing-core.js";
export { CLASSIFIABLE_REQUEST_TEXT_LIMIT, ClassificationError, classifyRequestDimensions, extractClassifiableRequestText, makeFakeRequestDecomposer, makeLanguageModelDimensionClassifier, makeRequestDecomposerLayer, parseDecompositionResult, RequestDecomposer, validateDecompositionInput, validateDecompositionResult } from "./request-classifier.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./router.js";
```
