# @velum-labs/routekit-accounts/pool

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `d7f6bcc42e4f863f426dff1eb370ba5825c339322ef5a562e86df1108445c3db`

## Root declarations

```ts
export type { AccountActivityCoordinatorOptions, AccountActivitySnapshot } from "./activity.js";
export type { AccountAuthCoordinatorOptions, AccountAuthSnapshot, AuthRecoveryClaim, AuthRecoveryOutcome, AuthRefreshFailureKind } from "./auth-health.js";
export type { CoordinatorResource, RedeemResetCreditInput, RedeemResetCreditResult, SubscriptionAccountSetOptions, SubscriptionExecutionObserver } from "./account-set.js";
export type { StateStoreDiagnostic, VersionedStateStoreOptions } from "./state-store.js";
export { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
export { AccountAuthCoordinator } from "./auth-health.js";
export { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES, SubscriptionAccountSet, SubscriptionAccountSetAuthError, SubscriptionAccountSetAuthRecoveryError, SubscriptionAccountSetExhaustedError } from "./account-set.js";
export { VersionedStateStore } from "./state-store.js";
```
