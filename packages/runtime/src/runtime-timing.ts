import { randomUUID } from "node:crypto";

export const DEFAULT_RUNTIME_TIMEOUTS = {
  remoteTool: 5 * 60 * 1000,
  sandboxCommand: 5 * 60 * 1000,
  session: 10 * 60 * 1000
} as const;

export function defineTimeouts<const T extends Record<string, number>>(timeouts: T): Readonly<T> {
  return Object.freeze({ ...timeouts });
}

export const MANAGED_SERVER_DEFAULTS = {
  startupTimeoutMs: 120_000,
  idleShutdownMs: 5 * 60 * 1000,
  shutdownGraceMs: 5_000,
  healthPollMs: 250,
  outputTailBytes: 64 * 1024
} as const;

export const CANDIDATE_ISOLATION_DEFAULTS = {
  containerImage: "node:22",
  containerEngine: "docker",
  containerWorkdir: "/workspace",
  microvmProvider: "vercel-sandbox",
  microvmRuntime: "node24",
  unknownRuntimeDigest: "unknown"
} as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a compact random id (hex, no dashes) with an optional prefix. */
export function randomId(length = 10, prefix?: string): string {
  const id = randomUUID().replace(/-/g, "").slice(0, length);
  return prefix !== undefined ? `${prefix}${id}` : id;
}

/**
 * Rough token estimate from text (and optional tool/JSON payload strings):
 * minimum 1 token, ceil(chars / 4).
 */
export function estimateTokens(...texts: string[]): number {
  let chars = 0;
  for (const text of texts) chars += text.length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: (error: Error) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${formatDurationMs(timeoutMs)}`);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
