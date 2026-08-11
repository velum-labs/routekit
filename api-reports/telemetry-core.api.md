# @velum-labs/routekit-telemetry-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `94dab27725440e47ab383629409e1c975ab343e49864e2b868ea0bb4bddf7d08`

## Root declarations

```ts
declare const BILLING_MODES: readonly ["metered-api", "subscription", "upstream-managed", "unknown"];
declare const COUNT_BUCKETS: readonly ["0", "1", "2-5", "6-20", ">20"];
declare const DAEMON_ACTIONS: readonly ["started", "stopped", "restarted", "reloaded", "roll_started", "roll_committed", "roll_failed"];
declare const DIALECTS: readonly ["openai-chat", "openai-responses", "anthropic-messages", "openai-embeddings"];
declare const OUTCOMES: readonly ["success", "error", "cancelled"];
declare const PREFERENCE_ACTIONS: readonly ["master", "category", "identity-reset"];
declare const REQUEST_KINDS: readonly ["chat", "responses", "messages", "embeddings"];
declare const RETRY_BUCKETS: readonly ["0", "1", "2", "3+"];
declare const TOKEN_BUCKETS: readonly ["0", "1-1k", "1k-10k", "10k-100k", ">100k", "unknown"];
export declare const COMMAND_ARCH_VALUES: readonly ["arm64", "x64", "other"];
export declare const COMMAND_EXIT_KINDS: readonly ["success", "usage_error", "command_error", "cancelled"];
export declare const COMMAND_NODE_MAJOR_VALUES: readonly ["22", "23", "24", "25", "26", "other"];
export declare const COMMAND_OS_VALUES: readonly ["darwin", "linux", "win32", "other"];
export declare const COMMAND_PATHS: readonly ["start", "stop", "status", "doctor", "usage", "usage.redeem", "leaderboard", "accounts.login", "accounts.add", "accounts.rename", "accounts.remove", "accounts.list", "accounts.status", "calls.inspect", "config.path", "config.show", "config.init", "config.edit", "config.import", "providers.add", "providers.remove", "providers.status", "models.list", "models.info", "remote.add", "remote.install", "remote.list", "remote.show", "remote.use", "remote.remove", "peer.add", "peer.show", "peer.remove", "token.issue", "token.list", "token.revoke", "codex", "claude", "cursor", "opencode", "codex.install", "codex.uninstall", "claude.install", "claude.uninstall", "daemon.reload", "daemon.status", "daemon.auth.show", "daemon.service.install", "daemon.service.uninstall", "daemon.service.status", "daemon.logs", "daemon.start", "daemon.stop", "daemon.restart", "daemon.upgrade"];
export declare const COMMAND_TARGET_KINDS: readonly ["local", "remote", "peer"];
export declare const DEFAULT_TELEMETRY_CATEGORIES: Readonly<TelemetryCategories>;
export declare const DURATION_BUCKETS: readonly ["<1s", "1-10s", "10-60s", "1-5m", "5-30m", ">30m"];
export declare const PRODUCT_OPERATIONS: readonly ["config_update", "config_import", "config_reload", "provider_enable", "provider_disable", "account_enroll", "account_enroll_activate", "account_remove", "account_sync", "launcher_prepare", "token_issue", "token_revoke"];
export declare const TELEMETRY_CATEGORIES: readonly ["usage", "reliability", "adoption"];
export declare const TELEMETRY_EVENT_DEFINITIONS: {
export declare const TELEMETRY_OUTCOMES: readonly ["success", "error", "cancelled"];
export declare const TELEMETRY_SCHEMA_INVENTORY: TelemetrySchemaInventory;
export declare const TELEMETRY_SCHEMA_VERSION = 1;
export declare function anonymousEventProperties(properties: Record<string, unknown>): Record<string, unknown>;
export declare function boundedShutdown(shutdown: () => Promise<unknown>, timeoutMs?: number): Promise<void>;
export declare function buildTelemetryEvent<N extends TelemetryEventName>(name: N, source: TelemetryEventProperties[N]): BuiltTelemetryEvent;
export declare function createConsentManager(options: ConsentOptions): {
export declare function durationBucket(ms: number): (typeof DURATION_BUCKETS)[number];
export declare function telemetryStatusMetadata(decision: ConsentDecision, destinationOrFields: TelemetryDestination | TelemetryFieldMap, schema?: TelemetrySchemaInventory): TelemetryStatus | {
export type BuiltTelemetryEvent = {
export type CommandCompletedProperties = {
export type ConsentDecision = {
export type ConsentFile = {
export type ConsentOptions = {
export type TelemetryCategories = Record<TelemetryCategory, boolean>;
export type TelemetryCategory = (typeof TELEMETRY_CATEGORIES)[number];
export type TelemetryDestination = {
export type TelemetryEventName = keyof typeof TELEMETRY_EVENT_DEFINITIONS;
export type TelemetryEventProperties = {
export type TelemetryFieldMap = Readonly<Record<string, readonly string[]>>;
export type TelemetrySchemaInventory = Readonly<Record<TelemetryEventName, {
export type TelemetryStatus = {
export {};
```
