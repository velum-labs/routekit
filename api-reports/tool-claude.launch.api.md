# @velum-labs/routekit-tool-claude/launch

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7288455c99b4878c55feb0312c6411974e2fa67ae9083218f9829ef35f28a606`

## Root declarations

```ts
export declare function claudeAgentsJson(profiles: readonly AgentProfile[]): string;
export declare function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string>;
export declare function claudeLaunchArgs(ctx: ToolLaunchContext): string[];
export declare function claudeModelId(modelId: string): string;
export declare function launchClaude(ctx: ToolLaunchContext): Promise<number>;
```
