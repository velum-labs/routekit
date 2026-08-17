import { spawn } from "node:child_process";

import type { ExperimentJob } from "@velum-labs/routekit-eval-contracts";

export type ExperimentExecutionResult = {
  output: unknown;
  stdout: string;
  stderr: string;
  latencyMs: number;
  providerCostUsd: number;
  infrastructureCostUsd: number;
};

export type ExperimentExecutionContext = {
  input: Uint8Array;
  signal?: AbortSignal;
};

export interface ExecutionBackend {
  execute(
    job: ExperimentJob,
    context: ExperimentExecutionContext
  ): Promise<ExperimentExecutionResult>;
  cancel?(jobId: string): Promise<void>;
}

export type LocalExecutionBackendOptions = {
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  maximumOutputBytes?: number;
};

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { text: stdout };
  }
}

export class LocalExecutionBackend implements ExecutionBackend {
  readonly #options: LocalExecutionBackendOptions;

  constructor(options: LocalExecutionBackendOptions = {}) {
    this.#options = options;
  }

  async execute(
    job: ExperimentJob,
    context: ExperimentExecutionContext
  ): Promise<ExperimentExecutionResult> {
    if (job.command === undefined) {
      throw new Error(`job ${job.id} does not define a local command`);
    }
    const startedAt = performance.now();
    const maximumOutputBytes = this.#options.maximumOutputBytes ?? 8 * 1024 * 1024;
    const child = spawn(job.command.executable, [...(job.command.args ?? [])], {
      cwd: this.#options.cwd,
      env: {
        ...process.env,
        ...this.#options.environment,
        ROUTEKIT_EXPERIMENT_ID: job.experimentId,
        ROUTEKIT_EXPERIMENT_JOB_ID: job.id,
        ROUTEKIT_EXPERIMENT_TASK_ID: job.taskId,
        ROUTEKIT_EXPERIMENT_TREATMENT_ID: job.treatmentId,
        ROUTEKIT_EXPERIMENT_SEED: String(job.seed),
        ROUTEKIT_EXPERIMENT_CONFIGURATION: JSON.stringify(job.configuration)
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    const timeoutMs = (job.command.timeoutSeconds ?? 30 * 60) * 1000;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= maximumOutputBytes) stdout.push(chunk);
      if (outputBytes > maximumOutputBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= maximumOutputBytes) stderr.push(chunk);
      if (outputBytes > maximumOutputBytes) child.kill("SIGTERM");
    });
    child.stdin.end(context.input);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const stderrText = Buffer.concat(stderr).toString("utf8");
    if (context.signal?.aborted === true) throw new Error(`job ${job.id} was cancelled`);
    if (timedOut) throw new Error(`job ${job.id} exceeded its ${timeoutMs}ms timeout`);
    if (outputBytes > maximumOutputBytes) {
      throw new Error(`job ${job.id} exceeded its ${maximumOutputBytes}-byte output limit`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `job ${job.id} exited with code ${String(exitCode)}${stderrText ? `: ${stderrText}` : ""}`
      );
    }
    return {
      output: parseOutput(stdoutText),
      stdout: stdoutText,
      stderr: stderrText,
      latencyMs: Math.round(performance.now() - startedAt),
      providerCostUsd: job.estimatedProviderCostUsd,
      infrastructureCostUsd: job.estimatedInfrastructureCostUsd
    };
  }
}
