# @velum-labs/routekit-tool-codex

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `c767b94cab3746685cd5a44963a6ff7a4a6bb27cc6e8df209cca8aae2381cd98`

## Root declarations

```ts
export declare const codexTool: ToolIntegration;
export type { CodexAgentRole, CodexModelPreset } from "./launch.js";
export type { CodexDriverConfig } from "./driver.js";
export type { CodexInstallInput, CodexInstallOwner, CodexInstallProfile, CodexInstallResult } from "./install.js";
export { codexAgentRoles, codexAgentRoleToml, codexAuthPath, codexCatalogEntries, codexLaunchConfigToml, codexListedStockSlugs, codexModelCatalogJson, codexPersistentModelCatalogJson, codexProfileFiles, codexProfileFileToml, hasCodexLogin, isCodexConfigFailure, launchCodex, readCodexCatalogTemplate, readCodexHomeModelsCache, readCodexModelsCache } from "./launch.js";
export { codexDriverConfigSchema, createCodexDriver } from "./driver.js";
export { codexIntegrationBlock, codexIntegrationConfigPath, installCodexIntegration, uninstallCodexIntegration } from "./install.js";
```
