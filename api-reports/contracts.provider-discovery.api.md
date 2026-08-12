# @velum-labs/routekit-contracts/provider-discovery

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a6946de192d317d1729e6151bb45f2b6c4c9222cbde4de4514687f2b61582661`

## Root declarations

```ts
export declare class ModelDiscoveryProtocolError extends Error {
export declare function decodeModelDiscovery(shape: ProviderDiscoveryResponseShape, payload: unknown, options?: DecodeModelDiscoveryOptions): DiscoveredProviderModel[];
export declare function decodeReasoningCapabilities(entry: unknown, options?: DecodeReasoningCapabilitiesOptions): ModelReasoningCapabilities | undefined;
export type DecodeModelDiscoveryOptions = Readonly<{
export type DecodeReasoningCapabilitiesOptions = Readonly<{
export type DiscoveredProviderModel = ModelSelectionSignals & {
export type ModelDiscoveryDiagnostic = Readonly<{
export type ModelDiscoveryDiagnosticCode = "invalid_model" | "duplicate_model" | "provider_hidden_model";
export type ModelDiscoveryProtocolErrorCode = "invalid_payload" | "missing_model_array" | "no_usable_models";
export type ProviderDiscoveryResponseShape = "openai" | "anthropic" | "google" | "codex" | "bedrock";
```
