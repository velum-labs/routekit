# @velum-labs/routekit-config

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `e2b367e2ade66073b345e073ae34c75dbb44668e601089f3bef141430d6911ce`

## Root declarations

```ts
export declare const DEFAULT_ROUTER_CONFIG: RouterConfig;
export declare function assertModelsAvailable(required: Iterable<string>, availableModels: Iterable<string>, message?: string): void;
export declare function globalRouterConfigPath(home?: string): string;
export declare function loadRouterConfig(input?: {
export declare function missingModelIds(required: Iterable<string>, availableModels: Iterable<string>): string[];
export declare function parseRouterConfigDocument(document: string, source?: string): RouterConfig;
export declare function resolveModelId(config: RouterConfig, availableModels: Iterable<string>, requested?: string): string;
export declare function routekitHome(env?: NodeJS.ProcessEnv): string;
export declare function updateRouterConfig(path: string, mutate: (draft: Record<string, unknown>) => void): RouterConfig;
export declare function writeRouterConfig(path: string, config: RouterConfig | unknown): string;
export type LoadedRouterConfig = {
export type { ApiProviderId, LeaderboardConfig, ModelPolicy, ProviderId, ProviderPolicy, RouterConfig, SubscriptionProviderId } from "@velum-labs/routekit-config-core";
export { API_PROVIDER_IDS, configuredProviderIds, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, parseRouterConfig, PROVIDER_IDS, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveLeaderboardConfig, routerConfigSchema, splitNamespacedModel, SUBSCRIPTION_PROVIDER_IDS } from "@velum-labs/routekit-config-core";
```
