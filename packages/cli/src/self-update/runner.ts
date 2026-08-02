import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  CommandOperation,
  CommandResult,
  CommandRunOptions,
  CommandRunner
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUTS: Record<CommandOperation, number> = {
  probe: 15_000,
  metadata: 30_000,
  install: 5 * 60_000
};

export const neutralSelfUpdateCwd = mkdtempSync(join(tmpdir(), "routekit-self-update-cwd-"));
mkdirSync(neutralSelfUpdateCwd, { recursive: true, mode: 0o700 });

export const defaultRunner: CommandRunner = async (executable, args, env, options = {}) => {
  const operation = options.operation ?? "probe";
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd: options.cwd ?? neutralSelfUpdateCwd,
      encoding: "utf8",
      env,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUTS[operation],
      maxBuffer: operation === "install" ? 8 * 1024 * 1024 : 1024 * 1024,
      windowsHide: true
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const candidate = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    return {
      stdout: candidate.stdout ?? "",
      stderr: candidate.stderr ?? "",
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
      ...(candidate.killed === true || candidate.signal === "SIGTERM" ? { timedOut: true } : {})
    };
  }
};

export async function runCommand(
  runner: CommandRunner,
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: CommandRunOptions
): Promise<CommandResult> {
  return await runner(executable, args, env, options);
}

export async function lastOutputLine(
  runner: CommandRunner,
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: CommandRunOptions
): Promise<string | undefined> {
  const result = await runCommand(runner, executable, args, env, options);
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}
