# @velum-labs/routekit-gateway/server

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `2df3cb59754c13883c36be357b253b3152d376ffaabf235ba53f2cc9f0a491e3`

## Root declarations

```ts
export type { Gateway, GatewayOptions, ModelCatalogRelay, ProviderRelayDialect, ProviderRelayPorts, RelayLifecycle, RequestRelay, TokenCountRelay } from "./server.js";
export type { RoutingPolicyReader } from "./eval-policy.js";
export type { SwitchingGatewayProxy, SwitchingGatewayProxyOptions } from "./switching-proxy.js";
export { RoutingPolicyReadError } from "./eval-policy.js";
export { startGateway } from "./server.js";
export { startSwitchingGatewayProxy } from "./switching-proxy.js";
```
