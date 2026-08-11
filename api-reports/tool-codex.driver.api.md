# @velum-labs/routekit-tool-codex/driver

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `ad9e0b5136c82ce0d29cc4d9c57c0ee623e1671560b0d2ab005a0b824c1fd7ba`

## Root declarations

```ts
export declare const codexDriverConfigSchema: z.ZodObject<{
export declare function createCodexDriver(): HarnessDriver<CodexDriverConfig>;
export type CodexDriverConfig = z.infer<typeof codexDriverConfigSchema>;
```
