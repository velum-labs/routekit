# @velum-labs/routekit-accounts/relay

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a166340db82f10c40fbcb0602ce2b53fde4f3f3f057b7c1d224335ba0bc3adcd`

## Root declarations

```ts
export type { AnthropicRelayOptions, SubscriptionRelay, SubscriptionRelayDialect } from "./relay.js";
export type { OpenSubscriptionRelaysOptions, OpenSubscriptionRelaysResult, SubscriptionAccountConfigs, SubscriptionAccountSets } from "./gateway.js";
export type { SubscriptionGateway, SubscriptionGatewayBackend, SubscriptionGatewayBackendRequestOptions, SubscriptionGatewayFactory, SubscriptionGatewayModelCatalogRelay, SubscriptionGatewayOptions, SubscriptionGatewayRelayDialect, SubscriptionGatewayRelayLifecycle, SubscriptionGatewayRelayPorts, SubscriptionGatewayRequestRelay, SubscriptionGatewayTokenCountRelay } from "./gateway-port.js";
export { AnthropicBackendRelay, forwardRelayHeaders, RelayOnlyBackend } from "./relay.js";
export { closeSubscriptionAccountSets, openSubscriptionAccountSets, openSubscriptionRelays, relayPorts, subscriptionRelaysFromAccountSets } from "./gateway.js";
```
