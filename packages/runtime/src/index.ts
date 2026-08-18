import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";
import type { Server } from "node:net";

import { executeWebRequest, runRouteKitEffect } from "./effect-api.js";
import { buildChildEnv } from "./environment.js";
import { distillLog } from "./logging.js";
import { terminateGroup } from "./process/process.js";
import { sleep } from "./runtime-timing.js";

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
export type { LifecycleLock } from "./services/authority/service.js";
export {
  acquireLifecycleLock,
  nextServiceGeneration
} from "./services/authority/service.js";
export { ControlClient, HttpControlTransport } from "./services/control-client/service.js";
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
export { startControlServer } from "./services/control-server/service.js";
export type { ControlServerOptions } from "./services/control-server/service.js";
export type {
  ServiceDaemonSpec,
  StartDaemonOptions,
  StartDaemonResult,
  StopDaemonResult
} from "./services/daemon/service.js";
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
} from "./services/daemon/service.js";
export type {
  ServiceRecord,
  ServiceRecordInput,
  ServiceRecordStore,
  ServiceSupervisorKind
} from "./services/daemon/records.js";
export {
  createServiceRecordStore,
  processAlive,
  processIdentity,
  SERVICE_HOME_MODE,
  SERVICE_SUPERVISOR_ENV,
  supervisorFromEnv
} from "./services/daemon/records.js";
export type {
  CommandRunner,
  DetectSupervisorOptions,
  ServiceUnitSpec,
  SupervisorController,
  SupervisorStatus
} from "./services/supervisor/service.js";
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
} from "./services/supervisor/service.js";
export type {
  UpgradeDaemonInput,
  UpgradeDaemonResult,
  UpgradeStrategy
} from "./services/upgrade/service.js";
export { planUpgrade, upgradeDetachedDaemon } from "./services/upgrade/service.js";
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

export function spawnTool(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: buildChildEnv({ extra: env }),
      ...(cwd !== undefined ? { cwd } : {})
    });
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 0));
  });
}

const DEFAULT_MAX_LOG_BYTES = 256 * 1024;

export type LoggedSpawnOptions = SpawnOptions & {
  logFile?: string;
  maxLogBytes?: number;
};

export type LoggedChild = {
  child: ChildProcess;
  log: () => string;
  spawnError: () => Error | undefined;
  logFile: () => string | undefined;
  closeLog: () => void;
};

export function spawnLogged(
  command: string,
  args: string[],
  options: LoggedSpawnOptions = {}
): LoggedChild {
  const { logFile, maxLogBytes, ...spawnOptions } = options;
  const cap = maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const child = spawn(command, args, {
    ...spawnOptions,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let buffer = "";
  let spawnError: Error | undefined;
  let file: WriteStream | undefined;
  if (logFile !== undefined) {
    try {
      file = createWriteStream(logFile, { flags: "a" });
      file.on("error", () => {});
    } catch {
      file = undefined;
    }
  }
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    file?.write(text);
    buffer += text;
    if (buffer.length > cap) buffer = buffer.slice(buffer.length - cap);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("error", (error: Error) => (spawnError = error));
  return {
    child,
    log: () => buffer,
    spawnError: () => spawnError,
    logFile: () => logFile,
    closeLog: () => {
      try {
        file?.end();
      } catch {
        // already closed
      }
    }
  };
}

function failureDetail(proc: LoggedChild): string {
  const distilled = distillLog(proc.log());
  const logPath = proc.logFile();
  const pathNote = logPath !== undefined ? `\n(full log: ${logPath})` : "";
  return `${distilled}${pathNote}`;
}

export async function waitForHttp(
  probeUrl: string,
  proc: LoggedChild,
  options: { timeoutMs: number; label: string; requireOk?: boolean }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const spawnError = proc.spawnError();
    if (spawnError !== undefined) {
      throw new Error(
        `${options.label} failed to start: ${spawnError.message}\n${failureDetail(proc)}`
      );
    }
    if (proc.child.exitCode !== null) {
      throw new Error(
        `${options.label} exited (code ${proc.child.exitCode}) before becoming ready\n${failureDetail(proc)}`
      );
    }
    try {
      const response = await runRouteKitEffect(executeWebRequest(probeUrl));
      if (options.requireOk !== true || response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(
    `${options.label} did not become ready within ${options.timeoutMs}ms (${lastError})\n${failureDetail(proc)}`
  );
}

export function waitForOutput(
  proc: LoggedChild,
  pattern: RegExp,
  options: { timeoutMs: number; label: string }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${options.label} did not start within ${options.timeoutMs}ms:\n${failureDetail(proc)}`
        )
      );
    }, options.timeoutMs);
    const poll = setInterval(() => {
      if (proc.spawnError() !== undefined) {
        cleanup();
        reject(
          new Error(
            `${options.label} failed to start: ${proc.spawnError()?.message}\n${failureDetail(proc)}`
          )
        );
      } else if (pattern.test(proc.log())) {
        cleanup();
        resolve();
      }
    }, 100);
    const onExit = (): void => {
      cleanup();
      reject(new Error(`${options.label} exited before becoming ready:\n${failureDetail(proc)}`));
    };
    proc.child.once("exit", onExit);
    function cleanup(): void {
      clearTimeout(deadline);
      clearInterval(poll);
      proc.child.off("exit", onExit);
    }
  });
}

/**
 * SIGTERM -> SIGKILL a child's whole process group. Thin wrapper over
 * the shared process-group supervisor primitive kept for the many
 * existing `terminate(child)` call sites.
 */
export function terminate(child: ChildProcess, graceMs = 5000): void {
  terminateGroup(child, graceMs);
}
