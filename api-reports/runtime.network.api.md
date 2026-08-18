# @velum-labs/routekit-runtime/network

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `0c1f04ea9355fee608046161563555b7a298ac72fd76d49208fc6cf67e1134fc`

## Root declarations

```ts
export type { DetectedProxy, DiscoverOrSpawnInput, DiscoverOrSpawnResult, PortlessModule, PortlessOptions, PortlessSession, RouteMapping, RouteStoreLike, SpawnedService } from "./network/portless.js";
export { assertAuthenticatedBind, isLoopbackHost, normalizeApiBaseUrl, trimSurroundingSlashes, trimTrailingSlashes } from "./network/url.js";
export { createActivePortlessSession, createPortlessSession, detectPortlessProxy, reapPortlessProject, reapPortlessService } from "./network/portless.js";
export { gatewayOpenAiBaseUrl, gatewayOrigin, gatewayPath } from "./network/gateway-url.js";
```
