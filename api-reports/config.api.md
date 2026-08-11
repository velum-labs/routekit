# @velum-labs/routekit-config

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `b028b416a42134c20fbef9d415d1c4a2ba182923c93ef770f4062d325bda5fd0`

## Root declarations

```ts
export declare const DEFAULT_ROUTER_CONFIG: RouterConfig;
export declare function assertModelsAvailable(required: Iterable<string>, availableModels: Iterable<string>, message?: string): void;
export declare function configuredProviderIds(config: RouterConfig): string[];
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
export { API_PROVIDER_IDS, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, parseRouterConfig, PROVIDER_IDS, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveLeaderboardConfig, routerConfigSchema, splitNamespacedModel, SUBSCRIPTION_PROVIDER_IDS } from "@velum-labs/routekit-config-core";
```
