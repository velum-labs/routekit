# @velum-labs/routekit-runtime/ports

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7fbf90a1d11d6d06ef8254760c9070d72843df1a430173ca43757f4243e09b94`

## Root declarations

```ts
export declare function freePort(): Promise<number>;
export declare function reservePort(): Promise<ReservedPort>;
export type ReservedPort = {
```
