/**
 * @velum-labs/routekit-harness-core is the single coding-agent harness contract:
 * driver -> instance -> session interfaces, the canonical harness event
 * union (with raw provider envelopes), one tagged error taxonomy with
 * derived retryability, deferred-based approvals with explicit policies,
 * status probes with an identity-checked disk cache, and an explicit driver
 * registry. Drivers (tool-codex, tool-claude, tool-cursor, tool-opencode)
 * implement this contract; orchestrators and launchers consume it.
 */

export type { ApprovalDecision, ApprovalPolicy, Deferred, PendingRequest } from "./approvals.js";
export {
  createDeferred,
  DEFAULT_AUTOMATION_APPROVAL_POLICY,
  decideApproval,
  PendingRequests
} from "./approvals.js";
export type { AsyncChannelOptions } from "./channel.js";
export { AsyncChannel } from "./channel.js";
export type {
  AnyHarnessDriver,
  DriverContext,
  HarnessDriver,
  HarnessInstance,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "./contract.js";
export type {
  CachedHarnessDriverInput,
  CliVersionProbeInput
} from "./driver-factory.js";
export {
  createCachedHarnessDriver,
  probeCliVersion,
  resolveDriverEnv
} from "./driver-factory.js";
export type { HarnessErrorCategory, HarnessErrorCode } from "./errors.js";
export {
  asHarnessError,
  HARNESS_ERROR_CODES,
  HarnessError,
  isRetryable
} from "./errors.js";
export type {
  HarnessContentStream,
  HarnessEvent,
  HarnessEventRaw,
  HarnessEventType,
  HarnessItemType,
  HarnessRequestType,
  HarnessTokenUsage,
  HarnessTurnEndReason
} from "./events.js";
export type { HarnessKind } from "./kinds.js";
export { HARNESS_KINDS, isHarnessKind } from "./kinds.js";
export type { TurnLease } from "./lifecycle.js";
export {
  ManagedSession,
  nowIso,
  resumeStringField,
  SessionResourceRegistry,
  SingleFlightTurnController
} from "./lifecycle.js";
export type { EventLogOptions } from "./logging.js";
export { EventLog } from "./logging.js";
export type {
  BuildChildEnvInput,
  CliCaptureOptions,
  CliCaptureResult,
  LoggedChild,
  LoggedSpawnOptions
} from "./process.js";
export {
  buildChildEnv,
  freePort,
  runCliCapture,
  spawnLogged,
  terminate,
  waitForHttp,
  waitForOutput,
  withDeadline,
  withTimeout
} from "./process.js";
export { DriverRegistry } from "./registry.js";
export type { HarnessAuthStatus, HarnessModelDescriptor, HarnessStatus } from "./status.js";
export {
  DEFAULT_STATUS_CACHE_DIR,
  readCachedStatus,
  statusSkipReason,
  writeCachedStatus
} from "./status.js";
export type {
  ParsedStreamJson,
  ParseStreamJsonOptions,
  StreamJsonEmitterOptions,
  StreamJsonStepText
} from "./stream-json.js";
export {
  asArray,
  asObject,
  asString,
  createStreamJsonStepEmitter,
  parseStreamJsonLine,
  parseStreamJsonTrajectory,
  STREAM_JSON_MAX_TEXT,
  STREAM_JSON_MAX_TOOL_INPUT,
  streamJsonResultContentText,
  stringifyStreamJsonValue,
  truncateStreamJsonText
} from "./stream-json.js";
export {
  createTrackedTmpDir,
  DEFAULT_TMP_MANIFEST,
  releaseTrackedTmpDir,
  sweepTrackedTmpDirs
} from "./tmp-sweep.js";
