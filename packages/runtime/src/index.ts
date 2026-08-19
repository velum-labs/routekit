export { hasFlag } from "./args.js";
export type {
  CapacityLease,
  CapacityPoolMember,
  CapacityPoolOptions,
  CapacityPoolStrategy
} from "./capacity-pool.js";
export { CapacityPool } from "./capacity-pool.js";
export { extendCleanupGrace, registerCleanup, runCleanups } from "./lifecycle/cleanup.js";
export type { CliCaptureOptions, CliCaptureResult } from "./process/cli-capture.js";
export { runCliCapture } from "./process/cli-capture.js";
export {
  CapacityPoolExhausted,
  DuplicateCapacityMember,
  EmptyCapacityPool,
  UnknownCapacityMember
} from "./effect/errors.js";
export type { BuildChildEnvInput } from "./environment.js";
export {
  buildChildEnv,
  commandOnPath,
  DEFAULT_BRIDGE_SCRUB_PREFIXES,
  definedEnv,
  SERVICE_UNSET_ENV,
  sanitizeServiceEnvironment,
  scrubBridgeEnv
} from "./environment.js";
export { gatewayOpenAiBaseUrl, gatewayOrigin, gatewayPath } from "./network/gateway-url.js";
export { distillLog } from "./logging.js";
export type {
  DetectedProxy,
  DiscoverOrSpawnInput,
  DiscoverOrSpawnResult,
  PortlessModule,
  PortlessOptions,
  PortlessSession,
  RouteMapping,
  RouteStoreLike,
  SpawnedService
} from "./network/portless.js";
export {
  createActivePortlessSession,
  createPortlessSession,
  detectPortlessProxy,
  reapPortlessProject,
  reapPortlessService
} from "./network/portless.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process/process.js";
export { superviseSpawn, terminateGroup, terminateProcessGroup } from "./process/process.js";
export type {
  OwnedResourceOptions,
  ResourceFinalizer,
  ResourceOwnership,
  ResourceScopeOptions
} from "./lifecycle/resource-scope.js";
export { ResourceDisposalTimeoutError, ResourceScope } from "./lifecycle/resource-scope.js";
export type { FileLock } from "./filesystem/runtime-files.js";
export {
  captureWorktreeDiff,
  ensureRunOutputDir,
  tryAcquireFileLock,
  writeFileAtomic
} from "./filesystem/runtime-files.js";
export { escapeMarkdownCell, markdownTable } from "./runtime-formatting.js";
export type { ReservedPort } from "./runtime-ports.js";
export { freePort, reservePort } from "./runtime-ports.js";
export {
  CANDIDATE_ISOLATION_DEFAULTS,
  DEFAULT_RUNTIME_TIMEOUTS,
  defineTimeouts,
  estimateTokens,
  formatDurationMs,
  MANAGED_SERVER_DEFAULTS,
  randomId,
  sleep,
  withDeadline,
  withTimeout
} from "./runtime-timing.js";
export type { LifecycleLock } from "./authority-service.js";
export {
  acquireLifecycleLock,
  nextServiceGeneration
} from "./authority-service.js";
export { ControlClient, HttpControlTransport } from "./control-client-service.js";
export type {
  ControlClientOptions,
  ControlErrorCode,
  ControlEvent,
  ControlFailure,
  ControlHandler,
  ControlHandlerContext,
  ControlPrincipal,
  ControlRequest,
  ControlResponse,
  ControlServerErrorContext,
  ControlSuccess,
  ControlTransport,
  RunningControlServer
} from "./control/protocol.js";
export {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  controlTokenMatches,
  generateControlToken
} from "./control/protocol.js";
export { startControlServer } from "./control-server-service.js";
export type { ControlServerOptions } from "./control-server-service.js";
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
export type { SseEvent } from "./streaming/sse.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./streaming/sse.js";
export type { SseTransformOptions } from "./streaming/stream-pump.js";
export { SseTransform, StreamPump } from "./streaming/stream-pump.js";
export type {
  IssuedToken,
  JoinCredential,
  TokenListEntry,
  TokenPlane,
  TokenPrincipal,
  TokenRecord,
  TokenRole,
  TokenStore
} from "./tokens/store.js";
export {
  createTokenStore,
  decodeJoinCredential,
  encodeJoinCredential,
  tokensPath
} from "./tokens/store.js";
export {
  assertAuthenticatedBind,
  isLoopbackHost,
  normalizeApiBaseUrl,
  trimSurroundingSlashes,
  trimTrailingSlashes
} from "./network/url.js";
export type {
  DocumentReadResult,
  DocumentStoreDiagnostic,
  VersionedDocumentStoreOptions
} from "./filesystem/versioned-document-store.js";
export { VersionedDocumentStore } from "./filesystem/versioned-document-store.js";
export type { LoggedChild, LoggedSpawnOptions } from "./process/managed-process.js";
export {
  spawnLogged,
  spawnTool,
  terminate,
  waitForHttp,
  waitForOutput
} from "./process/managed-process.js";
