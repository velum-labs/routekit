# @velum-labs/routekit-gateway/server

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7aae5694c53884da53185daf66cc26ff5701d828ee2e06d39ba4cdf0c5ca80f5`

## Root declarations

```ts
export type { Gateway, GatewayOptions, ModelCatalogRelay, ProviderRelayDialect, ProviderRelayPorts, RelayLifecycle, RequestRelay, TokenCountRelay } from "./server.js";
export type { RequestClassifierService } from "./request-classifier.js";
export type { RoutingPolicyReader } from "./eval-policy.js";
export type { SwitchingGatewayProxy, SwitchingGatewayProxyOptions } from "./switching-proxy.js";
export { RoutingPolicyReadError } from "./eval-policy.js";
export { startGateway } from "./server.js";
export { startSwitchingGatewayProxy } from "./switching-proxy.js";
```
