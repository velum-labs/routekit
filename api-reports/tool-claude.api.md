# @velum-labs/routekit-tool-claude

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `f421b28f8792e8387177be7bce563aba23e05508ec0677f6161c86c6ed2becd2`

## Root declarations

```ts
export declare const claudeTool: ToolIntegration;
export type { ClaudeDriverConfig, ClaudeDriverOptions, ClaudeQueryFn } from "./driver.js";
export type { ClaudeInstallInput, ClaudeInstallOwner, ClaudeInstallResult } from "./install.js";
export { claudeAgentsJson, claudeEnv, claudeLaunchArgs, launchClaude } from "./launch.js";
export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";
export { claudeIntegrationConfigPath, installClaudeIntegration, uninstallClaudeIntegration } from "./install.js";
```
