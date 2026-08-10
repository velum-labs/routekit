/**
 * The only accounts-owned integration seam to the HTTP gateway package.
 * Account selection and provider relays consume these contracts locally;
 * gateway construction remains replaceable at this boundary.
 */
export type {
  AnthropicRequest,
  Backend,
  BackendRequestOptions,
  Gateway,
  GatewayOptions,
  ProviderRelay,
  ProviderRelayDialect,
  ResponsesRequest
} from "@velum-labs/routekit-gateway";
export { startGateway as startSubscriptionGateway } from "@velum-labs/routekit-gateway";
