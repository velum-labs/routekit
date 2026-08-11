# @velum-labs/routekit-control

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `152254e91e01c03569a49865fd9ed48718616a45745bde095a8db230972b57f6`

## Root declarations

```ts
export declare class RouteKitControlClient {
export declare const MUTATING_ROUTEKIT_METHODS: ReadonlySet<RouteKitControlMethod>;
export declare function createRouteKitControlHandler(handlers: RouteKitControlHandlers, options?: {
export declare function routeKitControlSchemas<M extends RouteKitControlMethod>(method: M): {
export declare function validateRouteKitParams<M extends RouteKitControlMethod>(method: M, value: unknown): RouteKitControlParams[M];
export declare function validateRouteKitResult<M extends RouteKitControlMethod>(method: M, value: unknown): RouteKitControlResults[M];
export type { ConfigSnapshot, DaemonStatus, IssuedTokenResult, LaunchPreparation, ModelInfo, ModelRouteInfo, RouteKitAccountLimits, RouteKitAccountMemberStatus, RouteKitAccountStatusEntry, RouteKitAccountUsage, RouteKitCallInspection, RouteKitControlHandlers, RouteKitControlMethod, RouteKitControlParams, RouteKitControlResults, RouteKitLeaderboard, RouteKitLeaderboardRow, RouteKitMethodHandler, RouteKitRateLimitObservationSource, RouteKitResetCredit, RouteKitResetCreditSnapshot, TokenListEntry, TokenPlane, TokenRole } from "./protocol.js";
export type { ControlAuthorization, ControlIdempotencyPolicy, ControlMethodDefinition, ControlMutationClassification, ControlSchema } from "./method-registry.js";
export type { IdempotencyEntry, IdempotencyStoreOptions } from "./idempotency-store.js";
export { ControlMethodRegistry } from "./method-registry.js";
export { IdempotencyStore } from "./idempotency-store.js";
export { ROUTEKIT_CONTROL_CAPABILITY, ROUTEKIT_DAEMON_ROLL_CAPABILITY } from "./protocol.js";
```
