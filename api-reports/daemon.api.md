# @velum-labs/routekit-daemon

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7aef536a861a0c7d162c6f778a1cb3b5c9c408ac7b402d8f6c79a6037f4e1562`

## Root declarations

```ts
export declare function runRouteKitDaemonWorker(options: RouteKitDaemonOptions): Promise<never>;
export declare function startRouteKitDaemon(options: RouteKitDaemonOptions): Promise<RunningRouteKitDaemon>;
export declare function startRouteKitDaemonHost(options: RouteKitDaemonOptions & {
export type { DaemonPublicRecord, RevisionState } from "./daemon-state.js";
export type { RouteKitDaemonOptions, RunningRouteKitDaemon } from "./daemon-bootstrap.js";
export { ROUTEKIT_DAEMON_KIND, ROUTEKIT_PRODUCT } from "./daemon-bootstrap.js";
export { ROUTEKIT_DAEMON_WORKER_ENV } from "./host-protocol.js";
export { daemonPublicRecordPath, readDaemonRevisions, removeDaemonPublicRecord, writeDaemonPublicRecord, writeDaemonRevisions } from "./daemon-state.js";
```
