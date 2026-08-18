import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";
import type { Server } from "node:net";

import { executeWebRequest, runRouteKitEffect } from "../effect-api.js";
import { buildChildEnv } from "../environment.js";
import { distillLog } from "../logging.js";
import { terminateGroup } from "./process.js";
import { sleep } from "../runtime-timing.js";

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
