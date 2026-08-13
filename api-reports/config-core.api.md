# @velum-labs/routekit-config-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `acecada68fb5cc21f7765e4657d81c14c53c9508e06feb6db8d53fc9c59d5e6e`

## Root declarations

```ts
export declare function editConfig<T, U = T>(current: T, mutate: (draft: T) => void, clone: (value: T) => T, validate: (draft: T) => U): U;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function resolveLayer<T>(flag: T | undefined, config: T | undefined, fallback: T): LayeredValue<T>;
export type ConfigSource = "flag" | "config" | "default";
export type LayeredValue<T> = {
export type { ApiProviderId, LeaderboardConfig, ModelPolicy, ProviderId, ProviderPolicy, RouterConfig, SubscriptionProviderId } from "./router-config.js";
export { API_PROVIDER_IDS, configuredProviderIds, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, parseRouterConfig, PROVIDER_IDS, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveLeaderboardConfig, routerConfigSchema, splitNamespacedModel, SUBSCRIPTION_PROVIDER_IDS } from "./router-config.js";
```
