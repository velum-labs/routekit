/**
 * `@velum-labs/routekit-accounts` — the subscription pooling SDK.
 *
 * A cohesive, typed surface for pooling Claude Code and Codex OAuth
 * subscriptions behind one provider-native proxy: resolve an account set from
 * the official CLI login / an enrolled directory / explicit paths, select and
 * refresh members with quota-aware routing, and expose it over the gateway wire
 * protocols. `startSubscriptionProxy` is the one-call programmatic entrypoint;
 * `SubscriptionProxyClient` reads a running proxy's usage over a typed wire
 * contract. Product CLIs can wrap this module without owning account logic.
 */

export type {
  RedeemResetCreditInput,
  RedeemResetCreditResult,
  SubscriptionAccountSetOptions,
  SubscriptionExecutionObserver
} from "./account-set.js";
export {
  RateLimitTracker,
  SubscriptionAccountSet,
  SubscriptionAccountSetExhaustedError
} from "./account-set.js";
export type {
  ResolvedSubscriptionAccounts,
  SubscriptionAccountSource
} from "./account-source.js";
// Account sources (canonical / directory / explicit)
export { resolveSubscriptionAccounts } from "./account-source.js";
export type {
  AccountActivityCoordinatorOptions,
  AccountActivitySnapshot
} from "./activity.js";
export {
  AccountActivityCoordinator,
  subscriptionAccountIdentity
} from "./activity.js";
export type { AdmissionReason, PoolReadiness } from "./admission.js";
// Account set (selection, cooldown, refresh, usage tracking)
export {
  hasUsableCredits,
  isOverSwitchThreshold,
  isPoolEligible,
  memberHeadroom,
  poolReadiness,
  windowAdmissionStatus,
  windowHeadroom
} from "./admission.js";
export type { SubscriptionAccountBackendOptions } from "./backend.js";
// OpenAI-compatible backend over a subscription account set
export { SubscriptionAccountBackend } from "./backend.js";
export type { SubscriptionProxyClientOptions } from "./client.js";
export { SubscriptionProxyClient, SubscriptionProxyClientError } from "./client.js";
export type { CliproxyInstallResult, CliproxyStatus } from "./cliproxy.js";
// Managed CLIProxyAPI lifecycle
export {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  CLIPROXY_HOME_ENV,
  CLIPROXY_PINNED_VERSION,
  cliproxyApiKey,
  cliproxyAssetName,
  cliproxyBaseUrl,
  cliproxyBinaryPath,
  cliproxyConfigPath,
  cliproxyHome,
  cliproxyManagedPort,
  cliproxyStatus,
  ensureCliproxyConfig,
  installCliproxy,
  spawnCliproxy,
  writeCliproxyLoginConfig
} from "./cliproxy.js";
export type {
  CodexCatalogEntry,
  CodexRelayAuth,
  CodexRelayAuthSource,
  CodexRelayOptions,
  CodexStockEntry,
  ProviderRelayLogger
} from "./codex-relay.js";
// Relays (provider-native forwarding)
export { CodexBackendRelay, codexRelayAuth } from "./codex-relay.js";
export type {
  AccountStoreEntry,
  CapturedCliproxyCredential,
  CliproxyAccountEntry,
  CliproxyLoginInvocation,
  CliproxyLoginOptions,
  ResolvedAccountKind
} from "./connector.js";
// Account connectors: one login surface over native + cliproxy mechanisms
export {
  accountStoreEntries,
  captureCliproxyLoginCredentials,
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  cliproxyAuthDirectory,
  cliproxyCredentialValid,
  loginCliproxyAccount,
  removeCliproxyAccount,
  resolveAccountKind
} from "./connector.js";
export type {
  RemoveSubscriptionAccountResult,
  RenameSubscriptionAccountResult
} from "./credentials.js";
// Account credentials + enrollment
export {
  defaultSubscriptionAccountDirectory,
  defaultSubscriptionCredentialPath,
  enrollCurrentSubscription,
  loadSubscriptionCredential,
  persistSubscriptionCredential,
  removeSubscriptionAccount,
  renameSubscriptionAccount,
  sanitizeSubscriptionLabel,
  subscriptionCredentialLabel
} from "./credentials.js";
export type {
  OpenSubscriptionRelaysOptions,
  OpenSubscriptionRelaysResult,
  SubscriptionAccountConfigs,
  SubscriptionAccountSets
} from "./gateway.js";
// Gateway relay construction
export {
  openSubscriptionAccountSets,
  openSubscriptionRelays,
  subscriptionRelaysFromAccountSets
} from "./gateway.js";
export type {
  ManagedAccountLoginInvocation,
  ManagedAccountLoginOptions,
  ManagedLoginKeychain
} from "./managed-login.js";
// Native-connector managed logins (official CLI in an isolated profile)
export {
  browserOpenerStubDirectory,
  captureLoginCredential,
  claudeProfileKeychainService,
  parseAccountMode
} from "./managed-login.js";
export type {
  AdminUsageCost,
  AdminUsageRange,
  ConsumeResetCreditInput,
  ConsumeResetCreditResult,
  SubscriptionProvider
} from "./provider.js";
// Provider adapters
export { subscriptionProvider } from "./provider.js";
export type {
  StartSubscriptionProxyOptions,
  SubscriptionProxy
} from "./proxy.js";
// Programmatic proxy + typed client
export { NoSubscriptionAccountsError, startSubscriptionProxy } from "./proxy.js";
export type {
  AnthropicRelayOptions,
  SubscriptionRelay,
  SubscriptionRelayDialect
} from "./relay.js";
export {
  AnthropicBackendRelay,
  forwardRelayHeaders,
  RelayOnlyBackend
} from "./relay.js";
// Shared value types
export type {
  AccountLimits,
  CreditSnapshot,
  RateLimitObservationSource,
  RateLimitWindow,
  ResetCredit,
  ResetCreditSnapshot,
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionFailure,
  SubscriptionMemberStatus,
  SubscriptionSelectionStrategy
} from "./types.js";
export type { SubscriptionUsageSource } from "./usage.js";
// Fresh usage collection over live or locally opened account sets
export {
  collectSubscriptionUsage,
  DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS,
  openLocalSubscriptionUsage
} from "./usage.js";
export type { SubscriptionUsageResponse } from "./wire.js";
// Wire contract for the proxy usage endpoint
export {
  SUBSCRIPTION_USAGE_PATH,
  snapshotsToUsage,
  subscriptionUsageResponseSchema
} from "./wire.js";
