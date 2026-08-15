# @velum-labs/routekit-accounts/effect

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `ea954f3d6916628908c3cf55cc64fdbb1886d4187ee27769aeee65b944c201aa`

## Root declarations

```ts
export type { AccountActivityService } from "./activity.js";
export type { AccountAuthService } from "./auth-health.js";
export { AccountActivity } from "./activity.js";
export { AccountAuth } from "./auth-health.js";
export { openSubscriptionAccountSet, scopedSubscriptionAccountSet } from "./effect/account-set.js";
export { readBoundedSubscriptionBodyEffect } from "./effect/stream.js";
export { scopedRequestLease } from "./effect/request-lease.js";
```
