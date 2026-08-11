# @velum-labs/routekit-registry

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `aba7bc1df800c0bbf2f518f8419b22882729b95c11c8f360708713856e14fa0d`

## Root declarations

```ts
export declare const ACCOUNT_CONNECTORS: Readonly<Record<string, AccountConnectorInfo>>;
export declare const DEFAULT_MODEL_PRICING: Readonly<Record<string, RegistryModelPricing>>;
export declare const DEFAULT_REASONING_MODEL: string;
export declare const GATEWAY_DEFAULT_MLX_MODEL: string;
export declare const LOCAL_CATALOG_ENTRIES: readonly LocalCatalogModel[];
export declare const LOCAL_PROBE_MODEL: string;
export declare const PREFERRED_LOCAL_MODELS: readonly PreferredLocalModel[];
export declare const PRICING_ALIASES: Readonly<Record<string, string>>;
export declare const PROVIDERS: Readonly<Record<string, ProviderInfo>>;
export declare const SUBSCRIPTIONS: Readonly<Record<SubscriptionMode, SubscriptionInfo>>;
export declare function accountKindChoices(): readonly string[];
export declare function accountKindForCliproxyAuthType(type: string): string | undefined;
export declare function accountKinds(): readonly string[];
export declare function catalogDefaultModel(choice: string): string | undefined;
export declare function chatTemplateKwargsForModel(model: string): Readonly<Record<string, boolean>> | undefined;
export declare function curatedModels(choice: string): readonly string[];
export declare function defaultKeyEnv(provider: string): string | undefined;
export declare function providerDefaultBaseUrl(provider: string): string | undefined;
export declare function providerDiscovery(provider: string): ProviderDiscovery | undefined;
export declare function providerForAuthMode(mode: SubscriptionMode): string;
export declare function providerKeyProbe(provider: string): ProviderKeyProbe | undefined;
export declare function resolveAccountConnector(value: string): {
export declare function samplingOverridesForModel(model: string): Readonly<Record<string, number>>;
export declare function smokeModelForTool(tool: string): string | undefined;
export declare function subscriptionInfo(mode: SubscriptionMode): SubscriptionInfo;
export type AccountConnector = "native" | "cliproxy";
export type AccountConnectorInfo = {
export type LocalCatalogModel = {
export type LocalModelRole = "general" | "coder";
export type PreferredLocalModel = {
export type ProviderAuthStyle = "bearer" | "x-api-key" | "x-goog-api-key" | "aws-sdk";
export type ProviderDiscovery = {
export type ProviderDiscoveryResponseShape = "openai" | "anthropic" | "google" | "codex" | "bedrock";
export type ProviderInfo = {
export type ProviderKeyProbe = {
export type ProviderWire = {
export type ProviderWireProtocol = "openai" | "anthropic" | "google" | "codex" | "bedrock";
export type RegistryModelPricing = {
export type SubscriptionAdminInfo = {
export type SubscriptionInfo = {
export type SubscriptionMode = "claude-code" | "codex";
export type SubscriptionOAuthInfo = {
export type SubscriptionRateLimitInfo = {
export { REGISTRY };
```
