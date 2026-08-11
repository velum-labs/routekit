# @velum-labs/routekit-tool-claude/driver

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `8ddf50af402d92cbbc3a20b9fcaadcddbf41f606d6acb697810db6812c484c95`

## Root declarations

```ts
export declare const claudeDriverConfigSchema: z.ZodObject<{
export declare function createClaudeDriver(options?: ClaudeDriverOptions): HarnessDriver<ClaudeDriverConfig>;
export type ClaudeDriverConfig = z.infer<typeof claudeDriverConfigSchema>;
export type ClaudeDriverOptions = {
export type ClaudeQueryFn = (params: {
```
