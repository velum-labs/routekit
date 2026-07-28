import {
  COMMAND_PATHS,
  durationBucket,
  type CommandCompletedProperties
} from "@velum-labs/routekit-telemetry-core";

import { telemetryTargetIfResolved } from "./client.js";
import { routekitVersion } from "./state.js";

export type CommandTelemetryAttempt = {
  path: string;
  startedAt: number;
};
let currentAttempt: CommandTelemetryAttempt | undefined;

export function beginCommandTelemetry(path: string, startedAt = Date.now()): void {
  currentAttempt = normalizedTelemetryCommand(path) === undefined ? undefined : { path, startedAt };
}

export async function finishCommandTelemetry(
  exitKind: CommandCompletedProperties["exit_kind"]
): Promise<boolean> {
  const attempt = currentAttempt;
  currentAttempt = undefined;
  return await captureCommandCompleted(attempt, exitKind);
}

export function resetCommandTelemetryForTest(): void {
  currentAttempt = undefined;
}

const EXCLUDED_PREFIXES = ["telemetry", "daemon.run", "daemon.exec"] as const;
const COMMAND_TELEMETRY_TIMEOUT_MS = 1_500;

export function normalizedTelemetryCommand(
  path: string
): CommandCompletedProperties["command"] | undefined {
  const normalized = path.trim().replace(/\s+/g, ".");
  if (
    EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`))
  ) {
    return undefined;
  }
  return (COMMAND_PATHS as readonly string[]).includes(normalized)
    ? (normalized as CommandCompletedProperties["command"])
    : undefined;
}

function os(): CommandCompletedProperties["os"] {
  return (["darwin", "linux", "win32"] as const).includes(process.platform as never)
    ? (process.platform as CommandCompletedProperties["os"])
    : "other";
}
function arch(): CommandCompletedProperties["arch"] {
  return process.arch === "arm64" || process.arch === "x64" ? process.arch : "other";
}
function nodeMajor(): CommandCompletedProperties["node_major"] {
  const value = process.versions.node.split(".")[0] ?? "other";
  return (["22", "23", "24", "25", "26"] as const).includes(value as never)
    ? (value as CommandCompletedProperties["node_major"])
    : "other";
}

/** Best effort only: uses an already-resolved client and never discovers or starts a daemon. */
export async function captureCommandCompleted(
  attempt: CommandTelemetryAttempt | undefined,
  exitKind: CommandCompletedProperties["exit_kind"],
  now = Date.now()
): Promise<boolean> {
  if (attempt === undefined) return false;
  const command = normalizedTelemetryCommand(attempt.path);
  const target = telemetryTargetIfResolved();
  if (command === undefined || target === undefined) return false;
  const properties: CommandCompletedProperties = {
    command,
    cli_version: routekitVersion(),
    os: os(),
    arch: arch(),
    node_major: nodeMajor(),
    duration_bucket: durationBucket(Math.max(0, now - attempt.startedAt)),
    outcome: exitKind === "success" ? "success" : exitKind === "cancelled" ? "cancelled" : "error",
    exit_kind: exitKind,
    is_ci: process.env.CI !== undefined && process.env.CI !== "0" && process.env.CI !== "false",
    target_kind: target.kind
  };
  try {
    await target.client.call("telemetry.captureCommand", properties, {
      signal: AbortSignal.timeout(COMMAND_TELEMETRY_TIMEOUT_MS)
    });
    return true;
  } catch {
    return false;
  }
}
