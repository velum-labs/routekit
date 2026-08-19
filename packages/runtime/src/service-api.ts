export type { LifecycleLock } from "./authority-service.js";
export {
  acquireLifecycleLock,
  nextServiceGeneration
} from "./authority-service.js";
export type {
  ServiceDaemonSpec,
  StartDaemonOptions,
  StartDaemonResult,
  StopDaemonResult
} from "./daemon-service.js";
export {
  readLogTail,
  rotateLogFile,
  serviceLogPath,
  startDaemon,
  stopDaemonProcess,
  waitForProcessExit,
  waitForProcessExitEffect,
  waitForServiceReady,
  waitForServiceReadyEffect
} from "./daemon-service.js";
export type {
  ServiceRecord,
  ServiceRecordInput,
  ServiceRecordStore,
  ServiceSupervisorKind
} from "./daemon-records.js";
export {
  createServiceRecordStore,
  processAlive,
  processIdentity,
  SERVICE_HOME_MODE,
  SERVICE_SUPERVISOR_ENV,
  supervisorFromEnv
} from "./daemon-records.js";
export type {
  CommandRunner,
  DetectSupervisorOptions,
  ServiceUnitSpec,
  SupervisorController,
  SupervisorStatus
} from "./supervisor-service.js";
export {
  detectSupervisor,
  launchdAgentPlist,
  launchdLabel,
  launchdPlistPath,
  supervisorController,
  supervisorOperationTimeoutMs,
  systemdServiceUnit,
  systemdUnitName,
  systemdUnitPath
} from "./supervisor-service.js";
export type {
  UpgradeDaemonInput,
  UpgradeDaemonResult,
  UpgradeStrategy
} from "./upgrade-service.js";
export { planUpgrade, upgradeDetachedDaemon } from "./upgrade-service.js";
