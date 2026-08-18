# @velum-labs/routekit-contracts/model

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `4bdcd4d29a311b1a46f7c7879c9b16c88a4e32be3ebfaa9322f06353bf3d7b8f`

## Root declarations

```ts
export declare class ProviderFailureError extends Error {
export declare const CURSOR_MODEL_NAMESPACE = "routekit";
export declare function classifyProviderFailure(status: number | undefined, message: string, options?: {
export declare function cursorModelName(id: string): string;
export declare function isRetryableProviderFailure(category: ProviderFailureCategory): boolean;
export declare function parseRetryAfterSeconds(value: string | null | undefined, now?: () => number): number | undefined;
export declare function stripCursorNamespace(name: string): string | undefined;
export type AccountActivityState = {
export type AccountReadinessReason = {
export type AccountReadinessState = {
export type CapabilityStatus = "supported" | "unsupported" | "degraded" | "unknown";
export type CompositionalRoutingAttribution = {
export type ModelArchitecture = {
export type ModelCallContract<E extends {
export type ModelCallSideEffects = "none" | "read_only" | "writes_workspace" | "network" | "tool_execution" | "unknown";
export type ModelCallStatus = "pending" | "running" | "succeeded" | "failed" | "canceled" | "requires_action" | "skipped" | "unsupported";
export type ModelCapabilityMetadata = {
export type ModelChatMessage = {
export type ModelChatRole = "system" | "user" | "assistant" | "tool";
export type ModelEndpoint = {
export type ModelSelectionSignals = {
export type ModelUsage = {
export type ProviderError = {
export type ProviderErrorKind = "none" | "provider_error" | "validation_error" | "timeout" | "rate_limited" | "capability_missing" | "internal_error";
export type ProviderFailure = {
export type ProviderFailureCategory = "transient" | "quota_exhausted" | "auth_permanent" | "auth_transient" | "context_overflow" | "unknown";
export type RequestAttribution = {
export type RequestBillingMode = "api_key" | "subscription" | "client_auth";
export type UpstreamAuthState = "unknown" | "accepted" | "refreshing" | "backoff" | "rejected";
```
