# @velum-labs/routekit-tool-registry

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `9b0cd0bdc2fccc6fdcff0f3442442a50aaaec853ad77963d5ee1d9567ebd29ae`

## Root declarations

```ts
export declare const toolIntegrations: readonly ToolIntegration[];
export declare const toolRegistry: ToolRegistry;
export type { ClaudeInstallInput, ClaudeInstallOwner, ClaudeInstallResult } from "@velum-labs/routekit-tool-claude";
export type { CodexInstallInput, CodexInstallOwner, CodexInstallProfile, CodexInstallResult } from "@velum-labs/routekit-tool-codex";
export { claudeIntegrationConfigPath, installClaudeIntegration, uninstallClaudeIntegration } from "@velum-labs/routekit-tool-claude";
export { codexIntegrationBlock, codexIntegrationConfigPath, installCodexIntegration, uninstallCodexIntegration } from "@velum-labs/routekit-tool-codex";
```
