# @velum-labs/routekit-harness-core

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `7ccbcddbb3a69d52d4a95fe4755be3c612915d31b02833e1c6102907b71600e8`

## Root declarations

```ts
export type { AnyHarnessDriver, DriverContext, HarnessDriver, HarnessInstance, ResumeCursor, SessionHandle, SessionTurnInput, StartSessionOptions } from "./contract.js";
export type { ApprovalDecision, ApprovalPolicy, Deferred, PendingRequest } from "./approvals.js";
export type { AsyncChannelOptions } from "./channel.js";
export type { BuildChildEnvInput, CliCaptureOptions, CliCaptureResult, LoggedChild, LoggedSpawnOptions } from "./process.js";
export type { CachedHarnessDriverInput, CliVersionProbeInput } from "./driver-factory.js";
export type { EventLogOptions } from "./logging.js";
export type { HarnessAuthStatus, HarnessModelDescriptor, HarnessStatus } from "./status.js";
export type { HarnessContentStream, HarnessEvent, HarnessEventRaw, HarnessEventType, HarnessItemType, HarnessRequestType, HarnessTokenUsage, HarnessTurnEndReason } from "./events.js";
export type { HarnessErrorCategory, HarnessErrorCode } from "./errors.js";
export type { HarnessKind } from "./kinds.js";
export type { ParsedStreamJson, ParseStreamJsonOptions, StreamJsonEmitterOptions, StreamJsonStepText } from "./stream-json.js";
export type { TurnLease } from "./lifecycle.js";
export { AsyncChannel } from "./channel.js";
export { DEFAULT_STATUS_CACHE_DIR, readCachedStatus, statusSkipReason, writeCachedStatus } from "./status.js";
export { DriverRegistry } from "./registry.js";
export { EventLog } from "./logging.js";
export { HARNESS_KINDS, isHarnessKind } from "./kinds.js";
export { ManagedSession, nowIso, resumeStringField, SessionResourceRegistry, SingleFlightTurnController } from "./lifecycle.js";
export { asArray, asObject, asString, createStreamJsonStepEmitter, parseStreamJsonLine, parseStreamJsonTrajectory, STREAM_JSON_MAX_TEXT, STREAM_JSON_MAX_TOOL_INPUT, streamJsonResultContentText, stringifyStreamJsonValue, truncateStreamJsonText } from "./stream-json.js";
export { asHarnessError, HARNESS_ERROR_CODES, HarnessError, isRetryable } from "./errors.js";
export { buildChildEnv, freePort, runCliCapture, spawnLogged, terminate, waitForHttp, waitForOutput, withDeadline, withTimeout } from "./process.js";
export { createCachedHarnessDriver, probeCliVersion, resolveDriverEnv } from "./driver-factory.js";
export { createDeferred, DEFAULT_AUTOMATION_APPROVAL_POLICY, decideApproval, PendingRequests } from "./approvals.js";
export { createTrackedTmpDir, DEFAULT_TMP_MANIFEST, releaseTrackedTmpDir, sweepTrackedTmpDirs } from "./tmp-sweep.js";
```
