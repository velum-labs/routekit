# @velum-labs/routekit-accounts/pool

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `94cebf0683663820eae81af985ed76aa51e9a7fadcbd2b998dae98676a45d9fd`

## Root declarations

```ts
export type { AccountActivityCoordinatorOptions, AccountActivitySnapshot } from "./activity.js";
export type { AccountAuthCoordinatorOptions, AccountAuthSnapshot, AuthRecoveryClaim, AuthRecoveryOutcome, AuthRefreshFailureKind } from "./auth-health.js";
export type { CoordinatorResource, RedeemResetCreditInput, RedeemResetCreditResult, SubscriptionAccountSetOptions, SubscriptionExecutionObserver } from "./account-set/types.js";
export { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
export { AccountAuthCoordinator } from "./auth-health.js";
export { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES, SubscriptionAccountSet, SubscriptionAccountSetAuthError, SubscriptionAccountSetAuthRecoveryError, SubscriptionAccountSetExhaustedError } from "./account-set.js";
```
