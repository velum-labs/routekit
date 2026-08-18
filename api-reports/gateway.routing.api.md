# @velum-labs/routekit-gateway/routing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `33bf62f81181bf6b300e1ba7f50d6e447547b111c2cc2ea383782a184681ae23`

## Root declarations

```ts
export type { CatalogModelInfo, RoutingBackendOptions } from "./routing/router.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing/core.js";
export type { ObservedDecompositionResult, RequestDecomposerService } from "./services/request-classifier/service.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing/core.js";
export { CLASSIFIABLE_REQUEST_TEXT_LIMIT, ClassificationError, classifyRequestDimensions, extractClassifiableRequestText, makeFakeRequestDecomposer, makeLanguageModelDimensionClassifier, makeRequestDecomposerLayer, parseDecompositionResult, RequestDecomposer, validateDecompositionInput, validateDecompositionResult } from "./services/request-classifier/service.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./routing/router.js";
```
