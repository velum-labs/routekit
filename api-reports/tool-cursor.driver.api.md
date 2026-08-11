# @velum-labs/routekit-tool-cursor/driver

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `0452e9628a8319a400b1499486834b641d584dfc199542c9f7eccc3860822a9a`

## Root declarations

```ts
export declare const cursorDriverConfigSchema: z.ZodObject<{
export declare function createCursorDriver(): HarnessDriver<CursorDriverConfig>;
export type CursorDriverConfig = z.infer<typeof cursorDriverConfigSchema>;
```
