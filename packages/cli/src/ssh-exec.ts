/**
 * The one place RouteKit spawns `ssh`.
 *
 * Every remote administration path (the `control.v1` relay, token bootstrap,
 * and host provisioning) executes through `runSshCommand` so the argv shape,
 * `BatchMode` policy, output caps, and failure classification stay identical.
 * Arguments are always passed as argv entries after `--`; no caller may build
 * a shell string out of user input.
 */
import { spawn } from "node:child_process";

/** Refuse to buffer more than this much remote output in memory. */
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_CONNECT_TIMEOUT_MS = 10_000;

export type SshCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SshCommandOptions = {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  stdin?: string;
};

/** SSH failure classes RouteKit can act on, ordered most to least specific. */
export type SshFailureCode = "unauthorized" | "not_found" | "unavailable";

export type SshFailure = {
  code: SshFailureCode;
  /** Redacted, human-readable cause, or an empty string when none is known. */
  detail: string;
  /** True when the local `ssh` executable itself is missing. */
  missingSshClient: boolean;
};

function collectSecrets(
  value: unknown,
  key = "",
  output = new Set<string>(),
  seen = new WeakSet<object>(),
  sensitiveParent = false
): Set<string> {
  const sensitive = sensitiveParent || /token|secret|password|credential|api.?key/i.test(key);
  if (typeof value === "string" && sensitive) {
    if (value.length > 0) output.add(value);
  } else if (Array.isArray(value)) {
    if (seen.has(value)) return output;
    seen.add(value);
    for (const entry of value) collectSecrets(entry, key, output, seen, sensitive);
  } else if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return output;
    seen.add(value);
    for (const [name, entry] of Object.entries(value)) {
      collectSecrets(entry, name, output, seen, sensitive);
    }
  }
  return output;
}

/** Every string reachable under a sensitive-looking key in `value`. */
export function requestSecrets(value: unknown): Set<string> {
  return collectSecrets(value);
}

export function redactSensitiveText(text: string, secrets: Iterable<string> = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /("(?:token|secret|password|credential|api[_-]?key)"\s*:\s*")[^"]+/gi,
      "$1[redacted]"
    );
}

/**
 * SSH's own `ConnectTimeout` is bounded well below the overall command budget:
 * a provisioning step may legitimately run for minutes, but an unreachable
 * host must fail fast rather than hold the budget open.
 */
export function connectTimeoutSeconds(timeoutMs = DEFAULT_TIMEOUT_MS): number {
  return Math.max(1, Math.ceil(Math.min(timeoutMs, MAX_CONNECT_TIMEOUT_MS) / 1000));
}

export function sshArgv(
  host: string,
  argv: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds(timeoutMs)}`,
    "--",
    host,
    ...argv
  ];
}

/**
 * Classify a rejected SSH invocation. Callers own the surrounding sentence;
 * this decides the failure class and produces a redacted cause.
 */
export function classifySshFailure(
  error: unknown,
  secrets: Iterable<string> = []
): SshFailure {
  const candidate = error as {
    code?: string;
    stderr?: string | Buffer;
    message?: string;
  };
  if (candidate.code === "ENOENT") {
    return { code: "unavailable", detail: "", missingSshClient: true };
  }
  const rawStderr = typeof candidate.stderr === "string"
    ? candidate.stderr.trim()
    : Buffer.isBuffer(candidate.stderr)
      ? candidate.stderr.toString("utf8").trim()
      : "";
  const stderr = redactSensitiveText(rawStderr, secrets);
  const message = candidate.message === undefined
    ? ""
    : redactSensitiveText(candidate.message, secrets);
  const code: SshFailureCode = /permission denied|authentication failed/i.test(stderr)
    ? "unauthorized"
    : /routekit.*(?:not found|no such file)|command not found.*routekit/i.test(stderr)
      ? "not_found"
      : "unavailable";
  return {
    code,
    detail: stderr.length > 0 ? stderr : message,
    missingSshClient: false
  };
}

/**
 * Run one command on `host` and capture its output. A non-zero exit resolves
 * rather than rejects: callers that treat a failing status as fatal inspect
 * `exitCode` themselves, and provisioning probes expect failing statuses.
 * Rejections mean the invocation never produced a usable result: no `ssh`
 * binary, a timeout, an abort, or oversized output.
 */
export async function runSshCommand(
  host: string,
  argv: readonly string[],
  options: SshCommandOptions = {}
): Promise<SshCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn("ssh", sshArgv(host, argv, timeoutMs), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > OUTPUT_LIMIT_BYTES) {
        child.kill("SIGTERM");
        reject(new Error(`RouteKit remote command output from ${host} is too large`));
        return;
      }
      target.push(chunk);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      reject(new Error(`RouteKit remote command over SSH to ${host} was aborted`));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`RouteKit remote command over SSH to ${host} timed out`));
    }, timeoutMs);
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", () => {
      // The child process error/exit is reported through its own handlers.
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** A rejected `runSshCommand` carrying the remote stderr for classification. */
export function sshExitError(result: SshCommandResult, host: string): Error {
  return Object.assign(
    new Error(`ssh to ${host} exited with status ${result.exitCode}`),
    { stderr: result.stderr }
  );
}
