# @velum-labs/routekit-runtime/timing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `25533593ff3453389a5692141f3cb21f37155db70007ad3b3b5dc75f70cf189b`

## Root declarations

```ts
export declare const CANDIDATE_ISOLATION_DEFAULTS: {
export declare const DEFAULT_RUNTIME_TIMEOUTS: {
export declare const MANAGED_SERVER_DEFAULTS: {
export declare function defineTimeouts<const T extends Record<string, number>>(timeouts: T): Readonly<T>;
export declare function estimateTokens(...texts: string[]): number;
export declare function formatDurationMs(ms: number): string;
export declare function randomId(length?: number, prefix?: string): string;
export declare function sleep(ms: number): Promise<void>;
export declare function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: (error: Error) => void): Promise<T>;
```
