# @velum-labs/routekit-runtime/service

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `d52f1e02495311232539748e1f5efd55e0b20db1f37d479bfcd40cfdabebde96`

## Root declarations

```ts
export type { CommandRunner, DetectSupervisorOptions, ServiceUnitSpec, SupervisorController, SupervisorStatus } from "./services/supervisor/service.js";
export type { LifecycleLock } from "./services/authority/service.js";
export type { ServiceDaemonSpec, StartDaemonOptions, StartDaemonResult, StopDaemonResult } from "./services/daemon/service.js";
export type { ServiceRecord, ServiceRecordInput, ServiceRecordStore, ServiceSupervisorKind } from "./services/daemon/records.js";
export type { UpgradeDaemonInput, UpgradeDaemonResult, UpgradeStrategy } from "./services/upgrade/service.js";
export { acquireLifecycleLock, nextServiceGeneration } from "./services/authority/service.js";
export { createServiceRecordStore, processAlive, processIdentity, SERVICE_HOME_MODE, SERVICE_SUPERVISOR_ENV, supervisorFromEnv } from "./services/daemon/records.js";
export { detectSupervisor, launchdAgentPlist, launchdLabel, launchdPlistPath, supervisorController, supervisorOperationTimeoutMs, systemdServiceUnit, systemdUnitName, systemdUnitPath } from "./services/supervisor/service.js";
export { planUpgrade, upgradeDetachedDaemon } from "./services/upgrade/service.js";
export { readLogTail, rotateLogFile, serviceLogPath, startDaemon, stopDaemonProcess, waitForProcessExit, waitForProcessExitEffect, waitForServiceReady, waitForServiceReadyEffect } from "./services/daemon/service.js";
```
