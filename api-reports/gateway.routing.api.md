# @velum-labs/routekit-gateway/routing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `b162042cd378c03f1a35525f6e0cc283d7570cf91268faa6fd3c6f8b624f27c2`

## Root declarations

```ts
export type { CatalogModelInfo, RoutingBackendOptions } from "./router.js";
export type { ModelCatalogEntry, RoutePlan } from "./routing-core.js";
export type { RequestClassifierService } from "./request-classifier.js";
export { BackendExecutor, ModelCatalog, ModelResolver, ProviderLifecycle, RoutePlanner, RoutePolicy } from "./routing-core.js";
export { argmaxClassification, CLASSIFIABLE_PROFILE_DESCRIPTION_LIMIT, CLASSIFIABLE_PROFILE_EVIDENCE_LIMIT, CLASSIFIABLE_PROFILE_FALLBACK_LIMIT, CLASSIFIABLE_PROFILE_LIMIT, CLASSIFIABLE_REQUEST_TEXT_LIMIT, CLASSIFIER_CATALOG_TEXT_LIMIT, ClassificationError, classifiableProfilesFromPublished, classifyRequest, extractClassifiableRequestText, makeLanguageModelClassifier, makeRequestClassifierLayer, normalizeClassificationScores, parseClassifierScoreObject, RequestClassifier, validateClassifiableProfiles, validateClassificationResult } from "./request-classifier.js";
export { isSubscriptionProvider, modelPolicyAllowsModel, modelPolicyRuleMatches, NoModelAvailableError, RoutingBackend, UnknownModelError } from "./router.js";
```
