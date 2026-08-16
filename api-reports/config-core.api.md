# @velum-labs/routekit-config-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7b5bf19ef8dc1ed99633892771fcb8832d3fad9bf2fd5f14ffc2fcc852e6caa1`

## Root declarations

```ts
export declare function editConfig<T, U = T>(current: T, mutate: (draft: T) => void, clone: (value: T) => T, validate: (draft: T) => U): U;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function resolveLayer<T>(flag: T | undefined, config: T | undefined, fallback: T): LayeredValue<T>;
export type ConfigSource = "flag" | "config" | "default";
export type LayeredValue<T> = {
export type { ApiProviderId, LeaderboardConfig, ModelPolicy, ProviderId, ProviderPolicy, RouterConfig, SubscriptionProviderId } from "./router-config.js";
export { API_PROVIDER_IDS, configuredProviderIds, DEFAULT_CLASSIFIER_MODEL, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, PROVIDER_IDS, parseRouterConfig, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveLeaderboardConfig, routerConfigSchema, SUBSCRIPTION_PROVIDER_IDS, splitNamespacedModel } from "./router-config.js";
```
