# @velum-labs/routekit-config-core/router

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `04e922196a9fcf959dced0dafd5781564f12de0c9cd0ae15d082ff26e94ea014`

## Root declarations

```ts
export declare const API_PROVIDER_IDS: readonly ["openai", "anthropic", "bedrock", "google", "openrouter", "cliproxy"];
export declare const DEFAULT_CLASSIFIER_MODEL = "openai/gpt-5.6-luna";
export declare const DEFAULT_COMPOSITIONAL_ROUTING_UNKNOWN_WEIGHT = 0.25;
export declare const DEFAULT_LEADERBOARD_DURABLE_RETENTION_DAYS = 14;
export declare const DEFAULT_LEADERBOARD_LIVE_LIMIT = 1000;
export declare const DEFAULT_LEADERBOARD_LIVE_TTL_HOURS = 24;
export declare const PROVIDER_IDS: readonly ["openai", "anthropic", "bedrock", "google", "openrouter", "cliproxy", "codex", "claude-code"];
export declare const SUBSCRIPTION_PROVIDER_IDS: readonly ["codex", "claude-code"];
export declare const compositionalRoutingConfigSchema: z.ZodObject<{
export declare const leaderboardConfigSchema: z.ZodObject<{
export declare const modelPolicySchema: z.ZodObject<{
export declare const providerPolicySchema: z.ZodObject<{
export declare const reasoningCapabilityOverrideSchema: z.ZodType<Omit<ModelReasoningCapabilities, "provenance">>;
export declare const routerConfigSchema: z.ZodObject<{
export declare const routingObjectivePolicySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
export declare function configuredProviderIds(config: RouterConfig): ProviderId[];
export declare function parseRouterConfig(value: unknown): RouterConfig;
export declare function resolveCompositionalRoutingConfig(config: Pick<RouterConfig, "compositionalRouting">): CompositionalRoutingConfig;
export declare function resolveLeaderboardConfig(config: Pick<RouterConfig, "leaderboard">): LeaderboardConfig;
export declare function splitNamespacedModel(model: string): {
export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export type CompositionalRoutingConfig = z.infer<typeof compositionalRoutingConfigSchema>;
export type LeaderboardConfig = z.infer<typeof leaderboardConfigSchema>;
export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderPolicy = z.infer<typeof providerPolicySchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type RoutingObjectivePolicyConfig = z.infer<typeof routingObjectivePolicySchema>;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];
```
