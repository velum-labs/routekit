# @velum-labs/routekit-config-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `579b32c10b49750d1d7c30fca21c3c7e7d01a7bc4ee4661c1c5b44434553971c`

## Root declarations

```ts
export declare function editConfig<T, U = T>(current: T, mutate: (draft: T) => void, clone: (value: T) => T, validate: (draft: T) => U): U;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function resolveLayer<T>(flag: T | undefined, config: T | undefined, fallback: T): LayeredValue<T>;
export type ConfigSource = "flag" | "config" | "default";
export type LayeredValue<T> = {
export type { ApiProviderId, CompositionalRoutingConfig, LeaderboardConfig, ModelPolicy, ProviderId, ProviderPolicy, RouterConfig, RoutingObjectivePolicyConfig, SubscriptionProviderId } from "./router-config.js";
export { API_PROVIDER_IDS, compositionalRoutingConfigSchema, configuredProviderIds, DEFAULT_CLASSIFIER_MODEL, DEFAULT_COMPOSITIONAL_ROUTING_UNKNOWN_WEIGHT, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, PROVIDER_IDS, parseRouterConfig, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveCompositionalRoutingConfig, resolveLeaderboardConfig, routingObjectivePolicySchema, routerConfigSchema, SUBSCRIPTION_PROVIDER_IDS, splitNamespacedModel } from "./router-config.js";
```
