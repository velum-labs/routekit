# @velum-labs/routekit-gateway/server

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `3f390e7b5d6606fd715e67dc5a3f5ae4e8cfb063ea6463dfb91011d47bf2546d`

## Root declarations

```ts
export type { Gateway, GatewayOptions, ModelCatalogRelay, ProviderRelayDialect, ProviderRelayPorts, RelayLifecycle, RequestRelay, TokenCountRelay } from "./gateway-service.js";
export type { SwitchingGatewayProxy, SwitchingGatewayProxyOptions } from "./switching-proxy.js";
export { RoutingPolicyReadError } from "./routing/eval-policy.js";
export { startGateway } from "./gateway-service.js";
export { startSwitchingGatewayProxy } from "./switching-proxy.js";
```
