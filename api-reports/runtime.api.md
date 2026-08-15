# @velum-labs/routekit-runtime

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `0dae1200a91b6b94ab91dcc4f6ba22e761ce86135ba532fab31635d6985bd0e7`

## Root declarations

```ts
export declare function spawnLogged(command: string, args: string[], options?: LoggedSpawnOptions): LoggedChild;
export declare function spawnTool(command: string, args: string[], env: Record<string, string>, cwd?: string): Promise<number>;
export declare function terminate(child: ChildProcess, graceMs?: number): void;
export declare function waitForHttp(probeUrl: string, proc: LoggedChild, options: {
export declare function waitForOutput(proc: LoggedChild, pattern: RegExp, options: {
export type LoggedChild = {
export type LoggedSpawnOptions = SpawnOptions & {
export type { BuildChildEnvInput } from "./environment.js";
export type { CapacityLease, CapacityPoolMember, CapacityPoolOptions, CapacityPoolStrategy } from "./capacity-pool.js";
export type { CliCaptureOptions, CliCaptureResult } from "./cli-capture.js";
export type { CommandRunner, DetectSupervisorOptions, ServiceUnitSpec, SupervisorController, SupervisorStatus } from "./service/supervisors.js";
export type { ControlClientOptions, ControlErrorCode, ControlEvent, ControlFailure, ControlHandler, ControlHandlerContext, ControlPrincipal, ControlRequest, ControlResponse, ControlServerErrorContext, ControlSuccess, ControlTransport, RunningControlServer } from "./service/control-protocol.js";
export type { DetectedProxy, DiscoverOrSpawnInput, DiscoverOrSpawnResult, PortlessModule, PortlessOptions, PortlessSession, RouteMapping, RouteStoreLike, SpawnedService } from "./portless.js";
export type { DocumentReadResult, DocumentStoreDiagnostic, VersionedDocumentStoreOptions } from "./versioned-document-store.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process.js";
export type { FileLock } from "./runtime-files.js";
export type { IssuedToken, JoinCredential, TokenListEntry, TokenPlane, TokenPrincipal, TokenRecord, TokenRole, TokenStore } from "./tokens.js";
export type { LifecycleLock } from "./service/authority.js";
export type { OwnedResourceOptions, ResourceFinalizer, ResourceOwnership, ResourceScopeOptions } from "./resource-scope.js";
export type { ReservedPort } from "./runtime-ports.js";
export type { ServiceDaemonSpec, StartDaemonOptions, StartDaemonResult, StopDaemonResult } from "./service/daemon.js";
export type { ServiceRecord, ServiceRecordInput, ServiceRecordStore, ServiceSupervisorKind } from "./service/records.js";
export type { SseEvent } from "./sse.js";
export type { SseTransformOptions } from "./stream-pump.js";
export type { UpgradeDaemonInput, UpgradeDaemonResult, UpgradeStrategy } from "./service/upgrade.js";
export { CANDIDATE_ISOLATION_DEFAULTS, DEFAULT_RUNTIME_TIMEOUTS, defineTimeouts, estimateTokens, formatDurationMs, MANAGED_SERVER_DEFAULTS, randomId, sleep, withDeadline, withTimeout } from "./runtime-timing.js";
export { CONTROL_BODY_LIMIT_BYTES, CONTROL_PROTOCOL_VERSION, ControlError, controlTokenMatches, generateControlToken } from "./service/control-protocol.js";
export { CapacityPool } from "./capacity-pool.js";
export { CapacityPoolExhausted, DuplicateCapacityMember, EmptyCapacityPool, UnknownCapacityMember } from "./effect/errors.js";
export { ControlClient, HttpControlTransport } from "./service/control-client.js";
export { ResourceDisposalTimeoutError, ResourceScope } from "./resource-scope.js";
export { SseTransform, StreamPump } from "./stream-pump.js";
export { VersionedDocumentStore } from "./versioned-document-store.js";
export { acquireLifecycleLock, nextServiceGeneration } from "./service/authority.js";
export { assertAuthenticatedBind, isLoopbackHost, normalizeApiBaseUrl, trimSurroundingSlashes, trimTrailingSlashes } from "./url.js";
export { buildChildEnv, commandOnPath, DEFAULT_BRIDGE_SCRUB_PREFIXES, definedEnv, SERVICE_UNSET_ENV, sanitizeServiceEnvironment, scrubBridgeEnv } from "./environment.js";
export { captureWorktreeDiff, ensureRunOutputDir, tryAcquireFileLock, writeFileAtomic } from "./runtime-files.js";
export { createActivePortlessSession, createPortlessSession, detectPortlessProxy, reapPortlessProject, reapPortlessService } from "./portless.js";
export { createServiceRecordStore, processAlive, processIdentity, SERVICE_HOME_MODE, SERVICE_SUPERVISOR_ENV, supervisorFromEnv } from "./service/records.js";
export { createTokenStore, decodeJoinCredential, encodeJoinCredential, tokensPath } from "./tokens.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse.js";
export { detectSupervisor, launchdAgentPlist, launchdLabel, launchdPlistPath, supervisorController, supervisorOperationTimeoutMs, systemdServiceUnit, systemdUnitName, systemdUnitPath } from "./service/supervisors.js";
export { distillLog } from "./logging.js";
export { escapeMarkdownCell, markdownTable } from "./runtime-formatting.js";
export { extendCleanupGrace, registerCleanup, runCleanups } from "./cleanup.js";
export { freePort, reservePort } from "./runtime-ports.js";
export { gatewayOpenAiBaseUrl, gatewayOrigin, gatewayPath } from "./gateway-url.js";
export { hasFlag } from "./args.js";
export { planUpgrade, upgradeDetachedDaemon } from "./service/upgrade.js";
export { readLogTail, rotateLogFile, serviceLogPath, startDaemon, stopDaemonProcess, waitForProcessExit, waitForServiceReady, waitForServiceReadyEffect } from "./service/daemon.js";
export { runCliCapture } from "./cli-capture.js";
export { startControlServer } from "./service/control-server.js";
export { superviseSpawn, terminateGroup, terminateProcessGroup } from "./process.js";
```
