# @velum-labs/routekit-gateway/server

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `55f9ab73d8f127325bd454e80288d0fc9b7c7e0a6a00b9b65d4c11bf75b47c25`

## Root declarations

```ts
export type { Gateway, GatewayOptions, ModelCatalogRelay, ProviderRelayDialect, ProviderRelayPorts, RelayLifecycle, RequestRelay, TokenCountRelay } from "./services/gateway/service.js";
export type { SwitchingGatewayProxy, SwitchingGatewayProxyOptions } from "./services/switching-proxy/service.js";
export { RoutingPolicyReadError } from "./routing/eval-policy.js";
export { startGateway } from "./services/gateway/service.js";
export { startSwitchingGatewayProxy } from "./services/switching-proxy/service.js";
```
