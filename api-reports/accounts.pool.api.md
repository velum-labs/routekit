# @velum-labs/routekit-accounts/pool

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `3a2aa67bf1132d3ddb48a5a7c76686a9982a9238e0043fae7f60ccb0ec17f15f`

## Root declarations

```ts
export type { AccountActivityCoordinatorOptions, AccountActivitySnapshot } from "./activity.js";
export type { AccountAuthCoordinatorOptions, AccountAuthSnapshot, AuthRecoveryClaim, AuthRecoveryOutcome, AuthRefreshFailureKind } from "./auth-health.js";
export type { CoordinatorResource, RedeemResetCreditInput, RedeemResetCreditResult, SubscriptionAccountSetOptions, SubscriptionExecutionObserver } from "./account-set.js";
export { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
export { AccountAuthCoordinator } from "./auth-health.js";
export { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES, SubscriptionAccountSet, SubscriptionAccountSetAuthError, SubscriptionAccountSetAuthRecoveryError, SubscriptionAccountSetExhaustedError } from "./account-set.js";
```
