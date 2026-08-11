import { spawn } from "node:child_process";

import { terminateGroup } from "./process.js";

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
 * Run a CLI to completion, capturing stdout/stderr, with lifecycle-safe
 * process-group termination on timeout or cancellation.
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
        // The child may exit before consuming stdin; its exit still settles.
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
        exitCode: timedOut ? 124 : aborted ? 130 : (code ?? 0),
        timedOut,
        aborted,
        ...(aborted ? { abortReason } : {})
      });
    });
  });
}
