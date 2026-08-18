# @velum-labs/routekit-config

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `8b10633e93750c963d501fcde303a2e3db3129f358569321565cb38d845a557c`

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
export type { ApiProviderId, CompositionalRoutingConfig, LeaderboardConfig, ModelPolicy, ProviderId, ProviderPolicy, RouterConfig, RoutingObjectivePolicyConfig, SubscriptionProviderId } from "@velum-labs/routekit-config-core";
export { API_PROVIDER_IDS, compositionalRoutingConfigSchema, configuredProviderIds, DEFAULT_CLASSIFIER_MODEL, DEFAULT_COMPOSITIONAL_ROUTING_UNKNOWN_WEIGHT, DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS, DEFAULT_LEADERBOARD_LIVE_LIMIT, DEFAULT_LEADERBOARD_LIVE_TTL_HOURS, leaderboardConfigSchema, modelPolicySchema, PROVIDER_IDS, parseRouterConfig, providerPolicySchema, reasoningCapabilityOverrideSchema, resolveCompositionalRoutingConfig, resolveLeaderboardConfig, routingObjectivePolicySchema, routerConfigSchema, SUBSCRIPTION_PROVIDER_IDS, splitNamespacedModel } from "@velum-labs/routekit-config-core";
```
