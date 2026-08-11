# @velum-labs/routekit-tool-codex/launch

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `aeb204eb1ab697069ba9e4e737cca10beb96a386f5b610a169afa3d519d51bcc`

## Root declarations

```ts
export declare function codexAgentRoleToml(profile: AgentProfile): string;
export declare function codexAgentRoles(home: string, profiles: readonly AgentProfile[]): CodexAgentRole[];
export declare function codexAuthPath(home?: string): string;
export declare function codexCatalogEntries(spec: Pick<ToolLaunchSpec, "defaultModel" | "modelSelection" | "models">, template: CodexModelPreset, stockModels?: readonly CodexModelPreset[], options?: {
export declare function codexLaunchConfigToml(spec: Pick<ToolLaunchSpec, "gatewayUrl" | "defaultModel" | "reasoning" | "auth">, modelCatalogPath?: string, roles?: readonly CodexAgentRole[]): string;
export declare function codexListedStockSlugs(home?: string): string[];
export declare function codexModelCatalogJson(spec: Pick<ToolLaunchSpec, "defaultModel" | "models">, template: CodexModelPreset, stockModels?: readonly CodexModelPreset[], options?: {
export declare function codexPersistentModelCatalogJson(models: readonly CodexPersistentCatalogModel[], template?: CodexModelPreset | undefined): string;
export declare function codexProfileFileToml(model: string, provider?: string, modelCatalogPath?: string): string;
export declare function codexProfileFiles(home: string, models: readonly string[], provider?: string): string[];
export declare function createIsolatedCodexHome(prefix: string, env?: Record<string, string | undefined>): string;
export declare function hasCodexLogin(home?: string): boolean;
export declare function isCodexConfigFailure(code: number, stderr: string): boolean;
export declare function launchCodex(ctx: ToolLaunchContext, deps?: CodexLaunchDependencies): Promise<number>;
export declare function readCodexCatalogTemplate(home?: string): CodexModelPreset | undefined;
export declare function readCodexHomeModelsCache(codexHome: string): CodexModelPreset[];
export declare function readCodexModelsCache(home?: string): CodexModelPreset[];
export declare function resolveCodexHome(env?: Record<string, string | undefined>): string;
export declare function tomlKey(name: string): string;
export type CodexAgentRole = AgentProfile & {
export type CodexLaunchDependencies = {
export type CodexModelPreset = Record<string, unknown>;
export type CodexPersistentCatalogModel = {
```
