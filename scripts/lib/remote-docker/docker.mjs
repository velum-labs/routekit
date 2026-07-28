import { commandTimeoutMs, runCaptured } from "./process.mjs";

/**
 * Thin Docker CLI adapter. Failures throw with stdout/stderr attached so the
 * composition root can redact and diagnose without knowing Docker argv shape.
 */
export function createDockerClient({ fail, run = runCaptured } = {}) {
  return {
    async run(args, options = {}) {
      const result = await run("docker", args, {
        timeoutMs: options.timeoutMs ?? commandTimeoutMs("docker"),
        label: `docker ${args.join(" ")}`,
        env: options.env ?? process.env,
        input: options.input
      });
      if (options.allowFailure === true) return result;
      if (result.code !== 0) {
        fail(`docker ${args.join(" ")} failed`, {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr
        });
      }
      return result;
    }
  };
}
