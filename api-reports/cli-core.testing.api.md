# @velum-labs/routekit-cli-core/testing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7a3914af64bd2f1fbbcf23526cae26a5db5d6539da3abc3db25adfcd8fe5ad5a`

## Root declarations

```ts
export declare function runCliForTest(entry: string, args: readonly string[], options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">): CliTestResult;
export declare function withEnvironment<T>(changes: Record<string, string | undefined>, work: () => T): T;
export type CliTestResult = {
```
