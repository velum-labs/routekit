# @velum-labs/routekit-runtime/process

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `d6a15cf48fd8686148e69e22a0f4765c3a0da50c98bcc624fb5a77d8dd89dd2b`

## Root declarations

```ts
export type { CliCaptureOptions, CliCaptureResult } from "./process/cli-capture.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process/process.js";
export type { LoggedChild, LoggedSpawnOptions } from "./process/managed-process.js";
export { runCliCapture } from "./process/cli-capture.js";
export { spawnLogged, spawnTool, terminate, waitForHttp, waitForOutput } from "./process/managed-process.js";
export { superviseSpawn, terminateGroup, terminateProcessGroup } from "./process/process.js";
export { superviseSpawnEffect } from "./process/supervisor.js";
```
