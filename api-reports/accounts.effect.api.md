# @velum-labs/routekit-accounts/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `d7804e5f556c6a84cb91cfff2e124b25f015c7ea5103046b3182a59f25d8d905`

## Root declarations

```ts
export type { EffectAuthRecovery } from "./effect/auth-health.js";
export { EffectAccountActivityCoordinator, makeEffectAccountActivityCoordinator } from "./effect/activity.js";
export { EffectAccountAuthCoordinator, makeEffectAccountAuthCoordinator } from "./effect/auth-health.js";
export { EffectRateLimitTracker, makeEffectRateLimitTracker } from "./effect/rate-limit.js";
export { EffectSubscriptionAccountSet, openSubscriptionAccountSet, scopedSubscriptionAccountSet } from "./effect/account-set.js";
export { EffectSubscriptionProvider, EffectSubscriptionProxyClient, makeEffectSubscriptionProvider, makeEffectSubscriptionProxyClient } from "./effect/provider.js";
export { readBoundedSubscriptionBodyEffect } from "./effect/stream.js";
export { scopedRequestLease } from "./effect/request-lease.js";
```
