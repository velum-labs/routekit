import { type CliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import {
  COMMAND_PATHS,
  type CommandCompletedProperties,
  durationBucket
} from "@velum-labs/routekit-telemetry-core";
import type { CliSession } from "./cli-session.js";
import { telemetryTargetIfResolved } from "./client.js";
import { dottedCommandPath } from "./command-path.js";
import { routekitVersion } from "./state.js";

export type CommandTelemetryAttempt = {
  path: string;
  startedAt: number;
};

export class CommandTelemetry {
  private attempt: CommandTelemetryAttempt | undefined;

  constructor(
    private readonly session: CliSession,
    private readonly runtime: CliRuntime = processCliRuntime
  ) {}

  begin(path: string, startedAt = Date.now()): void {
    this.attempt = normalizedTelemetryCommand(path) === undefined ? undefined : { path, startedAt };
  }

  async finish(exitKind: CommandCompletedProperties["exit_kind"]): Promise<boolean> {
    const attempt = this.attempt;
    this.attempt = undefined;
    return await captureCommandCompleted(attempt, exitKind, Date.now(), this.session, this.runtime);
  }
}

const EXCLUDED_PREFIXES = ["telemetry", "daemon.run", "daemon.exec"] as const;
/** Actionable CLI commands that must not emit `command_completed`. */
export const TELEMETRY_EXCLUDED_COMMANDS = [
  "setup",
  "self-update",
  "version",
  "completion",
  "__complete",
  "__self-inspect",
  "credential.get",
  "token.shell"
] as const;
const COMMAND_TELEMETRY_TIMEOUT_MS = 1_500;

export function isTelemetryExcludedCommand(path: string): boolean {
  const normalized = dottedCommandPath(path);
  if (
    TELEMETRY_EXCLUDED_COMMANDS.includes(normalized as (typeof TELEMETRY_EXCLUDED_COMMANDS)[number])
  ) {
    return true;
  }
  return EXCLUDED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`)
  );
}

export function normalizedTelemetryCommand(
  path: string
): CommandCompletedProperties["command"] | undefined {
  const normalized = dottedCommandPath(path);
  if (isTelemetryExcludedCommand(normalized)) return undefined;
  return (COMMAND_PATHS as readonly string[]).includes(normalized)
    ? (normalized as CommandCompletedProperties["command"])
    : undefined;
}

function os(runtime: CliRuntime): CommandCompletedProperties["os"] {
  return (["darwin", "linux", "win32"] as const).includes(runtime.platform as never)
    ? (runtime.platform as CommandCompletedProperties["os"])
    : "other";
}
function arch(runtime: CliRuntime): CommandCompletedProperties["arch"] {
  return runtime.arch === "arm64" || runtime.arch === "x64" ? runtime.arch : "other";
}
function nodeMajor(runtime: CliRuntime): CommandCompletedProperties["node_major"] {
  const value = runtime.nodeVersion.split(".")[0] ?? "other";
  return (["22", "23", "24", "25", "26"] as const).includes(value as never)
    ? (value as CommandCompletedProperties["node_major"])
    : "other";
}

/** Best effort only: uses an already-resolved client and never discovers or starts a daemon. */
export async function captureCommandCompleted(
  attempt: CommandTelemetryAttempt | undefined,
  exitKind: CommandCompletedProperties["exit_kind"],
  now = Date.now(),
  session: CliSession,
  runtime: CliRuntime = processCliRuntime
): Promise<boolean> {
  if (attempt === undefined) return false;
  const command = normalizedTelemetryCommand(attempt.path);
  const target = telemetryTargetIfResolved(session);
  if (command === undefined || target === undefined) return false;
  const properties: CommandCompletedProperties = {
    command,
    cli_version: routekitVersion(),
    os: os(runtime),
    arch: arch(runtime),
    node_major: nodeMajor(runtime),
    duration_bucket: durationBucket(Math.max(0, now - attempt.startedAt)),
    outcome: exitKind === "success" ? "success" : exitKind === "cancelled" ? "cancelled" : "error",
    exit_kind: exitKind,
    is_ci: runtime.env.CI !== undefined && runtime.env.CI !== "0" && runtime.env.CI !== "false",
    target_kind: target.kind
  };
  try {
    await runRouteKitEffect(
      target.client.call("telemetry.captureCommand", properties, {
        signal: AbortSignal.timeout(COMMAND_TELEMETRY_TIMEOUT_MS)
      }),
      session.effectRuntime
    );
    return true;
  } catch {
    return false;
  }
}
