# @velum-labs/routekit-tool-cursor/launch

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `796afbbe1f42d50680d5d36832f0f70d8644a285dfb87612073a67dd567ebdc8`

## Root declarations

```ts
export declare function cursorByokBaseUrl(gatewayUrl: string): string;
export declare function cursorInstructions(gatewayUrl: string, model: string, apiKey?: string, reasoning?: ToolLaunchContext["spec"]["reasoning"]): string;
export declare function launchCursor(ctx: ToolLaunchContext): Promise<number>;
```
