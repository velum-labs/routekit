# @velum-labs/routekit-control

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `10369b7b25291b67cc93c38f6e4a2f5eb7787d9c38a2e79a63d1c38b9bf0c7f8`

## Root declarations

```ts
export declare class RouteKitControlClient {
export declare const MUTATING_ROUTEKIT_METHODS: ReadonlySet<RouteKitControlMethod>;
export declare function createRouteKitControlHandler(handlers: RouteKitControlHandlers, options?: {
export declare function resolveControlCallOptions<M extends RouteKitControlMethod>(method: M, options?: RouteKitCallOptions<M>): {
export declare function routeKitControlSchemas<M extends RouteKitControlMethod>(method: M): MethodSchemas[M];
export declare function validateRouteKitParams<M extends RouteKitControlMethod>(method: M, value: unknown): RouteKitControlParams[M];
export declare function validateRouteKitResult<M extends RouteKitControlMethod>(method: M, value: unknown): RouteKitControlResults[M];
export type { ConfigSnapshot, DaemonStatus, IssuedTokenResult, LaunchPreparation, ModelInfo, ModelRouteInfo, RouteKitAccountLimits, RouteKitAccountMemberStatus, RouteKitAccountStatusEntry, RouteKitAccountUsage, RouteKitCallInspection, RouteKitControlHandlers, RouteKitControlMethod, RouteKitControlParams, RouteKitControlResults, RouteKitLeaderboard, RouteKitLeaderboardRow, RouteKitMethodHandler, RouteKitRateLimitObservationSource, RouteKitResetCredit, RouteKitResetCreditSnapshot, TokenListEntry, TokenPlane, TokenRole } from "./protocol.js";
export type { ControlAuthorization, ControlIdempotencyPolicy, ControlMethodDefinition, ControlMutationClassification, ControlSchema } from "./method-registry.js";
export type { ControlMethodIdempotency, ControlMethodSpec, ControlMethodSurface, ProductOperation, RouteKitCallOptions } from "./method-table.js";
export type { IdempotencyEntry, IdempotencyStoreOptions } from "./idempotency-store.js";
export { CONTROL_METHODS, controlAuthorization, controlIdempotency, controlMutation, controlOperation, controlSurface, isRouteKitControlMethod, ROUTEKIT_CONTROL_METHODS } from "./method-table.js";
export { ControlMethodRegistry } from "./method-registry.js";
export { IdempotencyStore } from "./idempotency-store.js";
export { ROUTEKIT_CONTROL_CAPABILITY, ROUTEKIT_DAEMON_ROLL_CAPABILITY } from "./protocol.js";
```
