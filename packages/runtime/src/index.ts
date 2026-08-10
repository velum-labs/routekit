import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";
import type { Server } from "node:net";

import { buildChildEnv } from "./environment.js";
import { terminateGroup } from "./process.js";
import { sleep } from "./runtime-timing.js";

export { hasFlag } from "./args.js";
export type {
  CapacityLease,
  CapacityPoolMember,
  CapacityPoolOptions,
  CapacityPoolStrategy
} from "./capacity-pool.js";
export { CapacityPool } from "./capacity-pool.js";
export { extendCleanupGrace, registerCleanup, runCleanups } from "./cleanup.js";
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
export { gatewayOpenAiBaseUrl, gatewayOrigin, gatewayPath } from "./gateway-url.js";
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
} from "./portless.js";
export {
  createActivePortlessSession,
  createPortlessSession,
  detectPortlessProxy,
  reapPortlessProject,
  reapPortlessService
} from "./portless.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process.js";
export { superviseSpawn, terminateGroup } from "./process.js";
export type { FileLock } from "./runtime-files.js";
export {
  captureWorktreeDiff,
  ensureRunOutputDir,
  tryAcquireFileLock,
  writeFileAtomic
} from "./runtime-files.js";
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
export type { LifecycleLock } from "./service/authority.js";
export {
  acquireLifecycleLock,
  nextServiceGeneration
} from "./service/authority.js";
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
  RunningControlServer
} from "./service/control.js";
export {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  ControlError,
  controlTokenMatches,
  generateControlToken,
  startControlServer
} from "./service/control.js";
export type {
  ServiceDaemonSpec,
  StartDaemonOptions,
  StartDaemonResult,
  StopDaemonResult
} from "./service/daemon.js";
export {
  readLogTail,
  rotateLogFile,
  serviceLogPath,
  startDaemon,
  stopDaemonProcess,
  waitForProcessExit,
  waitForServiceReady
} from "./service/daemon.js";
export type {
  ServiceRecord,
  ServiceRecordInput,
  ServiceRecordStore,
  ServiceSupervisorKind
} from "./service/records.js";
export {
  createServiceRecordStore,
  processAlive,
  processIdentity,
  SERVICE_HOME_MODE,
  SERVICE_SUPERVISOR_ENV,
  supervisorFromEnv
} from "./service/records.js";
export type {
  CommandRunner,
  DetectSupervisorOptions,
  ServiceUnitSpec,
  SupervisorController,
  SupervisorStatus
} from "./service/supervisors.js";
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
} from "./service/supervisors.js";
export type {
  UpgradeDaemonInput,
  UpgradeDaemonResult,
  UpgradeStrategy
} from "./service/upgrade.js";
export { planUpgrade, upgradeDetachedDaemon } from "./service/upgrade.js";
export type { SseEvent } from "./sse.js";
export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse.js";
export type {
  IssuedToken,
  JoinCredential,
  TokenListEntry,
  TokenPlane,
  TokenPrincipal,
  TokenRecord,
  TokenRole,
  TokenStore
} from "./tokens.js";
export {
  createTokenStore,
  decodeJoinCredential,
  encodeJoinCredential,
  tokensPath
} from "./tokens.js";
export {
  assertAuthenticatedBind,
  isLoopbackHost,
  normalizeApiBaseUrl,
  trimSurroundingSlashes,
  trimTrailingSlashes
} from "./url.js";

export type CliCaptureOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** SIGTERM the process group after this long; exit code becomes 124. */
  timeoutMs?: number;
  /** Kills the process group on abort; exit code becomes 130. */
  signal?: AbortSignal;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  /** Called once per complete stdout line (and once for a trailing partial line). */
  onStdoutLine?: (line: string) => void;
  /** SIGTERM -> SIGKILL escalation grace (default 5000ms). */
  graceMs?: number;
};

export type CliCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  abortReason?: string;
};

function abortReasonText(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (reason !== undefined && reason !== null) return String(reason);
  return "aborted";
}

/**
 * Run a CLI to completion, capturing stdout/stderr, with the lifecycle rigor
 * every harness child needs: the child is spawned in its own process group and
 * timeout/abort kill the whole group with SIGTERM -> SIGKILL escalation, so a
 * CLI that spawns its own subprocesses (codex/claude/cursor all do) cannot
 * leave orphans behind. Rejects only on spawn failure (e.g. ENOENT); every
 * other outcome resolves. Exit codes mirror coreutils conventions: 124 for
 * timeout, 130 for abort.
 */
export function runCliCapture(
  command: string,
  args: string[],
  options: CliCaptureOptions = {}
): Promise<CliCaptureResult> {
  const signal = options.signal;
  if (signal?.aborted === true) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 130,
      timedOut: false,
      aborted: true,
      abortReason: abortReasonText(signal)
    });
  }
  return new Promise<CliCaptureResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      detached: true,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let pendingLine = "";
    let timedOut = false;
    let aborted = false;
    let abortReason: string | undefined;
    const flushLines = (final = false): void => {
      if (options.onStdoutLine === undefined) return;
      let newline = pendingLine.indexOf("\n");
      while (newline >= 0) {
        options.onStdoutLine(pendingLine.slice(0, newline));
        pendingLine = pendingLine.slice(newline + 1);
        newline = pendingLine.indexOf("\n");
      }
      if (final && pendingLine.length > 0) {
        options.onStdoutLine(pendingLine);
        pendingLine = "";
      }
    };
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateGroup(child, options.graceMs);
      }, options.timeoutMs);
    }
    const onAbort = (): void => {
      aborted = true;
      abortReason = signal !== undefined ? abortReasonText(signal) : "aborted";
      terminateGroup(child, options.graceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {
        // The child may exit before consuming stdin (EPIPE); the exit handler
        // still settles the result.
      });
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (options.onStdoutLine !== undefined) {
        pendingLine += chunk.toString("utf8");
        flushLines();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code) => {
      cleanup();
      flushLines(true);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        // 124 mirrors coreutils `timeout`; 130 mirrors SIGINT-style interruption.
        exitCode: timedOut ? 124 : aborted ? 130 : (code ?? 0),
        timedOut,
        aborted,
        ...(aborted ? { abortReason } : {})
      });
    });
  });
}

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

export function distillLog(raw: string, options: { maxLines?: number } = {}): string {
  const maxLines = options.maxLines ?? 16;
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  const errorPattern =
    /error|exception|traceback|fatal|denied|unauthorized|forbidden|invalid|not found|refused|timed? ?out|missing|failed|panic|429|401|403|500/i;
  const errorLines = lines.filter((line) => errorPattern.test(line));
  if (errorLines.length > 0) return errorLines.slice(-maxLines).join("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, "...", ...tail].join("\n");
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
      const response = await fetch(probeUrl);
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
