# @velum-labs/routekit-config-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7db680805f5ac8c6202ba95ac76e33eaa9e0a2bf29e4cfe1f1c1c6363356adcf`

## Root declarations

```ts
export declare function editConfig<T, U = T>(current: T, mutate: (draft: T) => void, clone: (value: T) => T, validate: (draft: T) => U): U;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function readJson(path: string): unknown;
export declare function readValidatedJson<T>(path: string, parse: (raw: unknown, source: string) => T, error?: (message: string) => Error): T;
export declare function resolveLayer<T>(flag: T | undefined, config: T | undefined, fallback: T): LayeredValue<T>;
export declare function writeJsonAtomic(path: string, value: unknown, options?: {
export type ConfigSource = "flag" | "config" | "default";
export type LayeredValue<T> = {
export type { ApiProviderId, LeaderboardConfig, ModelPolicy, ProviderId, ProviderPolicy, RouterConfig, SubscriptionProviderId } from "./router-config.js";
export { API_PROVIDER_IDS, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, parseRouterConfig, PROVIDER_IDS, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveLeaderboardConfig, routerConfigSchema, splitNamespacedModel, SUBSCRIPTION_PROVIDER_IDS } from "./router-config.js";
```
