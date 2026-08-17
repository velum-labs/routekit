import type { ExperimentJob } from "@velum-labs/routekit-eval-contracts";
import { putJsonArtifact } from "@velum-labs/routekit-eval-store/platform";
import { Sandbox } from "@vercel/sandbox";

import { artifactReferenceFromPath } from "./artifact-reference";
import { materializeArtifactMounts } from "./artifact-mounts";
import { standardizeExperimentOutput } from "./execute-job";
import { getArtifactStore, getExperimentLedger } from "./platform";

export type LaunchedSandboxJob =
  | {
      state: "terminal" | "deferred";
      jobId: string;
      workerId: string;
    }
  | {
      state: "launched";
      jobId: string;
      workerId: string;
      sandboxName: string;
      commandId: string;
      outputPath: string;
      startedAt: number;
    };

export type SandboxJobPollResult = "running" | "succeeded" | "retry" | "terminal";

function isWaitTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function stringConfiguration(job: ExperimentJob, key: string): string | undefined {
  const value = job.configuration[key];
  return typeof value === "string" ? value : undefined;
}

function numberConfiguration(job: ExperimentJob, key: string): number | undefined {
  const value = job.configuration[key];
  return typeof value === "number" ? value : undefined;
}

export async function launchSandboxJob(
  jobId: string,
  workerId: string
): Promise<LaunchedSandboxJob> {
  const ledger = await getExperimentLedger();
  const claimed = await ledger.claimJob(jobId, workerId, 10 * 60 * 1000);
  if (claimed === undefined) {
    const current = await ledger.getJob(jobId);
    if (
      current?.status === "succeeded" ||
      current?.status === "cancelled" ||
      (current?.status === "failed" && current.attemptCount >= 5)
    ) {
      return { state: "terminal", jobId, workerId };
    }
    return { state: "deferred", jobId, workerId };
  }
  if (
    claimed.job.executor !== "sandbox" ||
    claimed.job.command === undefined ||
    claimed.job.image === undefined
  ) {
    await ledger.failJob(jobId, {
      workerId,
      error: "sandbox job has no pinned image or command"
    });
    return { state: "terminal", jobId, workerId };
  }

  let sandbox: Sandbox | undefined;
  try {
    const input = await getArtifactStore().get(
      artifactReferenceFromPath(claimed.job.inputArtifact)
    );
    const vcpus = Math.max(
      1,
      Math.min(8, Math.floor(numberConfiguration(claimed.job, "vcpus") ?? 4))
    );
    const timeoutSeconds = Math.max(
      60,
      Math.min(24 * 60 * 60, claimed.job.command.timeoutSeconds ?? 2 * 60 * 60)
    );
    sandbox = await Sandbox.getOrCreate({
      name: `routekit-${claimed.job.id}`,
      image: claimed.job.image,
      resources: { vcpus },
      timeout: timeoutSeconds * 1000,
      persistent: true,
      tags: {
        experiment: claimed.job.experimentId.slice(0, 63),
        treatment: claimed.job.treatmentId.slice(0, 63)
      }
    });
    const directory = "/vercel/sandbox/routekit-job";
    const outputPath = stringConfiguration(claimed.job, "outputPath") ?? `${directory}/output.json`;
    await sandbox.fs.mkdir(directory, { recursive: true });
    await Promise.all([
      sandbox.fs.writeFile(`${directory}/input.bin`, input),
      sandbox.fs.writeFile(`${directory}/job.json`, `${JSON.stringify(claimed.job, null, 2)}\n`)
    ]);
    const mounts = await materializeArtifactMounts({
      sandbox,
      directory,
      configuration: claimed.job.configuration
    });
    const command = await sandbox.runCommand({
      cmd: claimed.job.command.executable,
      args: [...(claimed.job.command.args ?? [])],
      cwd: directory,
      env: {
        ROUTEKIT_EXPERIMENT_ID: claimed.job.experimentId,
        ROUTEKIT_EXPERIMENT_JOB_ID: claimed.job.id,
        ROUTEKIT_EXPERIMENT_TASK_ID: claimed.job.taskId,
        ROUTEKIT_EXPERIMENT_TREATMENT_ID: claimed.job.treatmentId,
        ROUTEKIT_EXPERIMENT_SEED: String(claimed.job.seed),
        ROUTEKIT_EXPERIMENT_CONFIGURATION: JSON.stringify(claimed.job.configuration),
        ROUTEKIT_EXPERIMENT_INPUT: `${directory}/input.bin`,
        ROUTEKIT_EXPERIMENT_MOUNTS: JSON.stringify(mounts),
        ROUTEKIT_EXPERIMENT_OUTPUT: outputPath
      },
      detached: true
    });
    return {
      state: "launched",
      jobId,
      workerId,
      sandboxName: sandbox.name,
      commandId: command.cmdId,
      outputPath,
      startedAt: Date.now()
    };
  } catch (error) {
    await sandbox?.stop().catch(() => undefined);
    const failed = await ledger.failJob(jobId, {
      workerId,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      state: failed.attemptCount < 5 ? "deferred" : "terminal",
      jobId,
      workerId
    };
  }
}

export async function pollSandboxJob(launched: LaunchedSandboxJob): Promise<SandboxJobPollResult> {
  if (launched.state !== "launched") return "terminal";
  const ledger = await getExperimentLedger();
  const current = await ledger.getJob(launched.jobId);
  if (current === undefined) throw new Error(`unknown sandbox job ${launched.jobId}`);
  if (current.status === "succeeded") return "succeeded";
  if (current.status === "cancelled") return "terminal";
  const heartbeat = await ledger.heartbeatJob(launched.jobId, launched.workerId, 10 * 60 * 1000);
  const sandbox = await Sandbox.get({ name: launched.sandboxName });
  if (!heartbeat) {
    await sandbox.stop();
    return current.status === "failed" && current.attemptCount < 5 ? "retry" : "terminal";
  }
  const command = await sandbox.getCommand(launched.commandId);
  let finished;
  try {
    finished = await command.wait({ signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    if (isWaitTimeout(error)) return "running";
    throw error;
  }

  const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
  if (finished.exitCode !== 0) {
    const failed = await ledger.failJob(launched.jobId, {
      workerId: launched.workerId,
      error: `sandbox command exited with ${finished.exitCode}: ${stderr.slice(0, 4000)}`,
      infrastructureCostUsd: current.job.estimatedInfrastructureCostUsd
    });
    await sandbox.stop();
    return failed.attemptCount < 5 ? "retry" : "terminal";
  }
  const hasOutputFile = await sandbox.fs.exists(launched.outputPath);
  const outputText = hasOutputFile
    ? await sandbox.fs.readFile(launched.outputPath, "utf8")
    : stdout;
  let output: unknown;
  try {
    output = JSON.parse(outputText) as unknown;
  } catch {
    output = { text: outputText };
  }
  const snapshot = await ledger.getExperiment(current.job.experimentId);
  if (snapshot === undefined) throw new Error(`unknown experiment ${current.job.experimentId}`);
  const result = {
    output: {
      result: output,
      sandbox: {
        name: sandbox.name,
        image: sandbox.image,
        region: sandbox.region,
        vcpus: sandbox.vcpus,
        memoryMb: sandbox.memory,
        durationMs: finished.durationMs
      }
    },
    stdout,
    stderr,
    latencyMs: finished.durationMs ?? Date.now() - launched.startedAt,
    providerCostUsd: current.job.estimatedProviderCostUsd,
    infrastructureCostUsd: current.job.estimatedInfrastructureCostUsd
  };
  const standardized = standardizeExperimentOutput(
    current.job,
    result,
    snapshot.experiment.manifest.dataset.hash
  );
  const artifacts = getArtifactStore();
  const [outputArtifact, logArtifact] = await Promise.all([
    putJsonArtifact(artifacts, `runs/${current.job.experimentId}/${current.job.id}`, standardized),
    artifacts.put(
      [`# job ${current.job.id}`, "", "## stdout", stdout, "", "## stderr", stderr].join("\n"),
      {
        kind: `logs/${current.job.experimentId}/${current.job.id}`,
        contentType: "text/plain",
        extension: "log"
      }
    )
  ]);
  await ledger.completeJob(launched.jobId, {
    workerId: launched.workerId,
    outputArtifact,
    logArtifact,
    providerCostUsd: result.providerCostUsd,
    infrastructureCostUsd: result.infrastructureCostUsd,
    latencyMs: result.latencyMs
  });
  await sandbox.stop();
  return "succeeded";
}
