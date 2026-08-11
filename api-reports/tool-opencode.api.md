# @velum-labs/routekit-tool-opencode

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `8b2824120374c2b44c2ebd64770c065b966257066b94bdd584301c18d1a83c22`

## Root declarations

```ts
export declare const opencodeTool: ToolIntegration;
export type { OpencodeBackend, OpencodeBackendFactory, OpencodeDriverConfig, OpencodeDriverOptions, OpencodeTurnPart, OpencodeTurnResult } from "./driver.js";
export { createOpencodeDriver, opencodeDriverConfigSchema } from "./driver.js";
export { launchOpencode, opencodeConfig, opencodeModelArg, opencodeProviderConfig } from "./launch.js";
```
