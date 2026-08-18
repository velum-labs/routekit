# @velum-labs/routekit-runtime/process

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `482503fe70103b635e2173c5562d93427f241c79f52592c3472c2805fad05c8f`

## Root declarations

```ts
export type { CliCaptureOptions, CliCaptureResult } from "./process/cli-capture.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process/process.js";
export { runCliCapture } from "./process/cli-capture.js";
export { superviseSpawn, terminateGroup, terminateProcessGroup } from "./process/process.js";
export { superviseSpawnEffect } from "./process/supervisor.js";
```
