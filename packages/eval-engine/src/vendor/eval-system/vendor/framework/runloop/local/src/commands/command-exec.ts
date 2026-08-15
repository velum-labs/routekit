import { spawn } from "node:child_process";
import { once } from "node:events";

import type { CommandExecResult } from "../../../../contracts/author/src/command.ts";

import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

interface ExecOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const collectStreamText = async (
  stream: NodeJS.ReadableStream | null
): Promise<string> => {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Run a subprocess once and capture its output (RFC 0002 command.md `ctx.exec`).
 * Never throws on a non-zero exit — the command inspects `exitCode` — and maps a
 * spawn failure (missing binary) to exit code 127 with the error on stderr, so a
 * command's `run` sees a uniform {@link CommandExecResult} rather than a rejected
 * promise. Uses `node:child_process` spawn directly: this is a plain one-shot
 * capture, not the harness JSONL streamer.
 */
export const runCommandExec = async (
  bin: string,
  args: readonly string[],
  options: ExecOptions
): Promise<CommandExecResult> => {
  try {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutPromise = collectStreamText(child.stdout);
    const stderrPromise = collectStreamText(child.stderr);
    await once(child, "spawn");
    const [stdout, stderr, closeArgs] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      once(child, "close"),
    ]);
    return {
      exitCode: typeof closeArgs[0] === "number" ? closeArgs[0] : 1,
      stderr,
      stdout,
    };
  } catch (error) {
    return {
      exitCode: 127,
      stderr: formatUnknownError(error),
      stdout: "",
    };
  }
};
