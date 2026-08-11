# @velum-labs/routekit-accounts

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `06d23ade56a6e8cf86e3ef462355b5a87432a72d997462365205587043363b64`

## Root declarations

```ts
export type { AccountActivityCoordinatorOptions, AccountActivitySnapshot } from "./activity.js";
export type { AccountAuthCoordinatorOptions, AccountAuthSnapshot, AuthRecoveryClaim, AuthRecoveryOutcome, AuthRefreshFailureKind } from "./auth-health.js";
export type { AccountLimits, CreditSnapshot, RateLimitDiagnostic, RateLimitObservationSource, RateLimitWindow, ResetCredit, ResetCreditSnapshot, SubscriptionAccountSetSnapshot, SubscriptionCredential, SubscriptionFailure, SubscriptionMemberStatus, SubscriptionSelectionStrategy } from "./types.js";
export type { AccountStoreEntry, CapturedCliproxyCredential, CliproxyAccountEntry, CliproxyLoginInvocation, CliproxyLoginOptions, ResolvedAccountKind } from "./connector.js";
export type { AdminUsageCost, AdminUsageRange, ConsumeResetCreditInput, ConsumeResetCreditResult, SubscriptionProvider, SubscriptionRefreshFailure, SubscriptionStreamOutcome } from "./provider.js";
export type { AnthropicRelayOptions, SubscriptionRelay, SubscriptionRelayDialect } from "./relay.js";
export type { CliproxyInstallResult, CliproxyStatus } from "./cliproxy.js";
export type { CodexCatalogEntry, CodexRelayAuth, CodexRelayAuthSource, CodexRelayOptions, CodexStockEntry, ProviderRelayLogger } from "./codex-relay.js";
export type { CooldownContext } from "./rate-limit-tracker.js";
export type { CoordinatorResource, RedeemResetCreditInput, RedeemResetCreditResult, SubscriptionAccountSetOptions, SubscriptionExecutionObserver } from "./account-set.js";
export type { ManagedAccountLoginInvocation, ManagedAccountLoginOptions, ManagedLoginKeychain } from "./managed-login.js";
export type { OpenSubscriptionRelaysOptions, OpenSubscriptionRelaysResult, SubscriptionAccountConfigs, SubscriptionAccountSets } from "./gateway.js";
export type { PoolReadiness } from "./admission.js";
export type { RemoveSubscriptionAccountResult, RenameSubscriptionAccountResult } from "./credentials.js";
export type { ResolvedSubscriptionAccounts, SubscriptionAccountSource } from "./account-source.js";
export type { StartSubscriptionProxyOptions, SubscriptionProxy } from "./proxy.js";
export type { StateStoreDiagnostic, VersionedStateStoreOptions } from "./state-store.js";
export type { SubscriptionAccountBackendOptions } from "./backend.js";
export type { SubscriptionDiscoveredModel, SubscriptionProviderBackend, SubscriptionProviderBackendFactory, SubscriptionProviderBackendOptions, SubscriptionProviderTransport, SubscriptionResponseMode } from "./provider-port.js";
export type { SubscriptionGateway, SubscriptionGatewayBackend, SubscriptionGatewayBackendRequestOptions, SubscriptionGatewayFactory, SubscriptionGatewayModelCatalogRelay, SubscriptionGatewayOptions, SubscriptionGatewayRelayDialect, SubscriptionGatewayRelayLifecycle, SubscriptionGatewayRelayPorts, SubscriptionGatewayRequestRelay, SubscriptionGatewayTokenCountRelay } from "./gateway-port.js";
export type { SubscriptionProxyClientOptions } from "./client.js";
export type { SubscriptionUsageResponse } from "./wire.js";
export type { SubscriptionUsageSource } from "./usage.js";
export { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
export { AccountAuthCoordinator } from "./auth-health.js";
export { AnthropicBackendRelay, forwardRelayHeaders, RelayOnlyBackend } from "./relay.js";
export { CLIPROXY_API_KEY_ENV, CLIPROXY_BASE_URL_ENV, CLIPROXY_HOME_ENV, CLIPROXY_PINNED_VERSION, cliproxyApiKey, cliproxyAssetName, cliproxyBaseUrl, cliproxyBinaryPath, cliproxyConfigPath, cliproxyHome, cliproxyManagedPort, cliproxyStatus, ensureCliproxyConfig, installCliproxy, spawnCliproxy, writeCliproxyLoginConfig } from "./cliproxy.js";
export { CodexBackendRelay, codexRelayAuth } from "./codex-relay.js";
export { NoSubscriptionAccountsError, startSubscriptionProxy } from "./proxy.js";
export { RateLimitTracker } from "./rate-limit-tracker.js";
export { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES, SubscriptionAccountSet, SubscriptionAccountSetAuthError, SubscriptionAccountSetAuthRecoveryError, SubscriptionAccountSetExhaustedError } from "./account-set.js";
export { SUBSCRIPTION_USAGE_PATH, snapshotsToUsage, subscriptionUsageResponseSchema } from "./wire.js";
export { SubscriptionAccountBackend } from "./backend.js";
export { SubscriptionProviderRequestError, SubscriptionRefreshError, subscriptionProvider } from "./provider.js";
export { SubscriptionProxyClient, SubscriptionProxyClientError } from "./client.js";
export { VersionedStateStore } from "./state-store.js";
export { accountStoreEntries, captureCliproxyLoginCredentials, cliproxyAccountEntries, cliproxyAccountMatchesKind, cliproxyAuthDirectory, cliproxyCredentialValid, loginCliproxyAccount, removeCliproxyAccount, resolveAccountKind } from "./connector.js";
export { browserOpenerStubDirectory, captureLoginCredential, claudeProfileKeychainService, parseAccountMode } from "./managed-login.js";
export { closeSubscriptionAccountSets, openSubscriptionAccountSets, openSubscriptionRelays, relayPorts, subscriptionRelaysFromAccountSets } from "./gateway.js";
export { collectSubscriptionUsage, DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS, openLocalSubscriptionUsage } from "./usage.js";
export { defaultSubscriptionAccountDirectory, defaultSubscriptionCredentialPath, enrollCurrentSubscription, loadSubscriptionCredential, persistSubscriptionCredential, removeSubscriptionAccount, renameSubscriptionAccount, sanitizeSubscriptionLabel, subscriptionCredentialFingerprint, subscriptionCredentialLabel } from "./credentials.js";
export { hasUsableCredits, isOverSwitchThreshold, isPoolEligible, memberHeadroom, poolReadiness, windowAdmissionStatus, windowHeadroom } from "./admission.js";
export { parseSubscriptionModels } from "./subscription-discovery.js";
export { resolveSubscriptionAccounts } from "./account-source.js";
```
