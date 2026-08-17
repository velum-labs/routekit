import { Sandbox } from "@vercel/sandbox";
import {
  EVAL_ATTRIBUTION_HEADER,
  EVAL_POLICY_BYPASS_HEADER,
  type ExperimentJob
} from "@velum-labs/routekit-eval-contracts";
import {
  LocalExecutionBackend,
  extractClassificationPrediction,
  type ExperimentExecutionResult
} from "@velum-labs/routekit-eval-core/experiment";
import {
  EXPERIMENT_JOB_MAXIMUM_ATTEMPTS,
  putJsonArtifact
} from "@velum-labs/routekit-eval-store/platform";

import { artifactReferenceFromPath } from "./artifact-reference";
import { materializeArtifactMounts } from "./artifact-mounts";
import { promptFromInput } from "./hosted-request";
import { getArtifactStore, getExperimentLedger } from "./platform";

export class ExperimentJobDeferredError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`job ${jobId} is waiting for an experiment concurrency slot`);
    this.name = "ExperimentJobDeferredError";
    this.jobId = jobId;
  }
}

function stringConfiguration(job: ExperimentJob, key: string): string | undefined {
  const value = job.configuration[key];
  return typeof value === "string" ? value : undefined;
}

function numberConfiguration(job: ExperimentJob, key: string): number | undefined {
  const value = job.configuration[key];
  return typeof value === "number" ? value : undefined;
}

function parseInput(input: Uint8Array): unknown {
  const text = new TextDecoder().decode(input);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { prompt: text };
  }
}

function providerCost(payload: unknown, fallback: number): number {
  if (typeof payload !== "object" || payload === null) return fallback;
  const object = payload as Record<string, unknown>;
  const direct = object.cost_usd ?? object.cost;
  if (typeof direct === "number" && direct >= 0) return direct;
  const usage = object.usage;
  if (typeof usage === "object" && usage !== null) {
    const nested = (usage as Record<string, unknown>).cost_usd;
    if (typeof nested === "number" && nested >= 0) return nested;
  }
  return fallback;
}

function digestFromImage(image: string | undefined): string {
  const match = /@sha256:([a-f0-9]{64})$/i.exec(image ?? "");
  if (match?.[1] === undefined) throw new Error("experiment job image has no immutable digest");
  return match[1].toLowerCase();
}

export function standardizeExperimentOutput(
  job: ExperimentJob,
  result: ExperimentExecutionResult,
  datasetHash: string
): unknown {
  const model = stringConfiguration(job, "model");
  const configuredProvider = stringConfiguration(job, "provider");
  const provider = configuredProvider ?? model?.split("/", 1)[0];
  const provenance = {
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    imageDigest: digestFromImage(job.image),
    datasetHash,
    configurationHash: job.configurationHash,
    seed: job.seed
  };
  const prediction = extractClassificationPrediction(result.output, {
    latencyMs: result.latencyMs,
    providerCostUsd: result.providerCostUsd,
    infrastructureCostUsd: result.infrastructureCostUsd,
    provenance
  });
  if (prediction === undefined) return result.output;
  return {
    result: result.output,
    prediction: {
      ...prediction,
      latencyMs: result.latencyMs,
      providerCostUsd: result.providerCostUsd,
      infrastructureCostUsd: result.infrastructureCostUsd,
      provenance: {
        ...prediction.provenance,
        ...provenance
      }
    }
  };
}

async function executeHostedModel(
  job: ExperimentJob,
  input: Uint8Array,
  onPaidCallAttempted: () => Promise<void>
): Promise<ExperimentExecutionResult> {
  const endpoint =
    stringConfiguration(job, "endpoint") ??
    process.env.ROUTEKIT_GATEWAY_URL ??
    process.env.AI_GATEWAY_URL;
  if (endpoint === undefined || endpoint.length === 0) {
    throw new Error("ROUTEKIT_GATEWAY_URL or treatment configuration.endpoint is required");
  }
  const aiGatewayEndpoint = /^https:\/\/ai-gateway\.vercel\.sh(?:\/|$)/iu.test(endpoint);
  const token =
    process.env.ROUTEKIT_EVAL_TOKEN ??
    process.env.AI_GATEWAY_API_KEY ??
    (aiGatewayEndpoint ? process.env.VERCEL_OIDC_TOKEN : undefined);
  if (token === undefined || token.length === 0) {
    throw new Error(
      "ROUTEKIT_EVAL_TOKEN, AI_GATEWAY_API_KEY, or Vercel OIDC authentication is required"
    );
  }
  const model = stringConfiguration(job, "model");
  if (model === undefined) throw new Error(`hosted-model job ${job.id} has no pinned model`);
  const parsed = parseInput(input);
  const { messages, extra } = promptFromInput(parsed, job.treatmentId);
  const startedAt = performance.now();
  const timeoutSeconds = Math.max(
    1,
    Math.min(240, numberConfiguration(job, "timeoutSeconds") ?? 240)
  );
  await onPaidCallAttempted();
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": job.idempotencyKey,
      [EVAL_POLICY_BYPASS_HEADER]: "1",
      [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
        purpose: "eval",
        role: "candidate",
        runId: job.experimentId,
        caseId: job.taskId
      })
    },
    body: JSON.stringify({
      ...extra,
      model,
      messages,
      seed: job.seed,
      stream: false
    }),
    signal: AbortSignal.timeout(timeoutSeconds * 1000)
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `hosted model call failed (${response.status}): ${responseText.slice(0, 2000)}`
    );
  }
  const payload = JSON.parse(responseText) as unknown;
  const actualModel =
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { model?: unknown }).model === "string"
      ? (payload as { model: string }).model
      : undefined;
  return {
    output: {
      requestedModel: model,
      actualModel,
      response: payload
    },
    stdout: responseText,
    stderr: "",
    latencyMs: Math.round(performance.now() - startedAt),
    providerCostUsd: providerCost(payload, job.estimatedProviderCostUsd),
    infrastructureCostUsd: job.estimatedInfrastructureCostUsd
  };
}

async function executeSandbox(
  job: ExperimentJob,
  input: Uint8Array
): Promise<ExperimentExecutionResult> {
  if (job.command === undefined || job.image === undefined) {
    throw new Error(`sandbox job ${job.id} requires a command and image`);
  }
  const vcpus = Math.max(1, Math.min(8, Math.floor(numberConfiguration(job, "vcpus") ?? 4)));
  const timeoutSeconds = Math.max(
    60,
    Math.min(24 * 60 * 60, job.command.timeoutSeconds ?? 2 * 60 * 60)
  );
  const sandbox = await Sandbox.getOrCreate({
    name: `routekit-${job.id}`,
    image: job.image,
    resources: { vcpus },
    timeout: timeoutSeconds * 1000,
    persistent: true,
    tags: {
      experiment: job.experimentId.slice(0, 63),
      treatment: job.treatmentId.slice(0, 63)
    }
  });
  try {
    const directory = "/vercel/sandbox/routekit-job";
    await sandbox.fs.mkdir(directory, { recursive: true });
    await Promise.all([
      sandbox.fs.writeFile(`${directory}/input.bin`, input),
      sandbox.fs.writeFile(`${directory}/job.json`, `${JSON.stringify(job, null, 2)}\n`)
    ]);
    const mounts = await materializeArtifactMounts({
      sandbox,
      directory,
      configuration: job.configuration
    });
    const command = await sandbox.runCommand({
      cmd: job.command.executable,
      args: [...(job.command.args ?? [])],
      cwd: directory,
      env: {
        ROUTEKIT_EXPERIMENT_ID: job.experimentId,
        ROUTEKIT_EXPERIMENT_JOB_ID: job.id,
        ROUTEKIT_EXPERIMENT_TASK_ID: job.taskId,
        ROUTEKIT_EXPERIMENT_TREATMENT_ID: job.treatmentId,
        ROUTEKIT_EXPERIMENT_SEED: String(job.seed),
        ROUTEKIT_EXPERIMENT_CONFIGURATION: JSON.stringify(job.configuration),
        ROUTEKIT_EXPERIMENT_INPUT: `${directory}/input.bin`,
        ROUTEKIT_EXPERIMENT_MOUNTS: JSON.stringify(mounts),
        ROUTEKIT_EXPERIMENT_OUTPUT: `${directory}/output.json`
      },
      timeoutMs: timeoutSeconds * 1000
    });
    const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
    if (command.exitCode !== 0) {
      throw new Error(`sandbox command exited with ${command.exitCode}: ${stderr.slice(0, 4000)}`);
    }
    const outputPath = stringConfiguration(job, "outputPath") ?? `${directory}/output.json`;
    const hasOutputFile = await sandbox.fs.exists(outputPath);
    const outputText = hasOutputFile ? await sandbox.fs.readFile(outputPath, "utf8") : stdout;
    let output: unknown;
    try {
      output = JSON.parse(outputText) as unknown;
    } catch {
      output = { text: outputText };
    }
    return {
      output: {
        result: output,
        sandbox: {
          name: sandbox.name,
          image: sandbox.image,
          region: sandbox.region,
          vcpus: sandbox.vcpus,
          memoryMb: sandbox.memory,
          durationMs: command.durationMs
        }
      },
      stdout,
      stderr,
      latencyMs: command.durationMs ?? sandbox.totalDurationMs ?? 0,
      providerCostUsd: job.estimatedProviderCostUsd,
      infrastructureCostUsd: job.estimatedInfrastructureCostUsd
    };
  } finally {
    await sandbox.stop();
  }
}

async function execute(
  job: ExperimentJob,
  input: Uint8Array,
  onPaidCallAttempted: () => Promise<void>
): Promise<ExperimentExecutionResult> {
  if (job.executor === "hosted-model") {
    return executeHostedModel(job, input, onPaidCallAttempted);
  }
  if (job.executor === "sandbox") return executeSandbox(job, input);
  return new LocalExecutionBackend({
    cwd: process.env.EXPERIMENT_LOCAL_WORKING_DIRECTORY
  }).execute(job, { input });
}

export async function processExperimentJob(jobId: string, workerId: string): Promise<void> {
  const ledger = await getExperimentLedger();
  const beforeClaim = await ledger.getJob(jobId);
  if (beforeClaim === undefined) throw new Error(`unknown experiment job ${jobId}`);
  const claimed = await ledger.claimJob(jobId, workerId, 10 * 60 * 1000);
  if (claimed === undefined) {
    const current = await ledger.getJob(jobId);
    if (
      current?.status === "succeeded" ||
      current?.status === "cancelled" ||
      (current?.status === "failed" &&
        (!current.retryable ||
          current.attemptCount >= EXPERIMENT_JOB_MAXIMUM_ATTEMPTS))
    ) {
      return;
    }
    throw new ExperimentJobDeferredError(jobId);
  }
  const artifacts = getArtifactStore();
  let paidCallAttempted = false;
  let executionResult: ExperimentExecutionResult | undefined;
  try {
    const inputReference = artifactReferenceFromPath(claimed.job.inputArtifact);
    const input = await artifacts.get(inputReference);
    const result = await execute(claimed.job, input, async () => {
      const disabled = await ledger.disableJobRetries(jobId, workerId);
      if (!disabled) {
        throw new Error(`worker ${workerId} lost job ${jobId} before paid request dispatch`);
      }
      paidCallAttempted = true;
    });
    executionResult = result;
    const snapshot = await ledger.getExperiment(claimed.job.experimentId);
    if (snapshot === undefined) {
      throw new Error(`unknown experiment ${claimed.job.experimentId}`);
    }
    const output = standardizeExperimentOutput(
      claimed.job,
      result,
      snapshot.experiment.manifest.dataset.hash
    );
    const [outputArtifact, logArtifact] = await Promise.all([
      putJsonArtifact(artifacts, `runs/${claimed.job.experimentId}/${claimed.job.id}`, output),
      artifacts.put(
        [
          `# job ${claimed.job.id}`,
          "",
          "## stdout",
          result.stdout,
          "",
          "## stderr",
          result.stderr
        ].join("\n"),
        {
          kind: `logs/${claimed.job.experimentId}/${claimed.job.id}`,
          contentType: "text/plain",
          extension: "log"
        }
      )
    ]);
    await ledger.completeJob(jobId, {
      workerId,
      outputArtifact,
      logArtifact,
      providerCostUsd: result.providerCostUsd,
      infrastructureCostUsd: result.infrastructureCostUsd,
      latencyMs: result.latencyMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = claimed.job.executor === "hosted-model" && paidCallAttempted;
    await ledger.failJob(jobId, {
      workerId,
      error: terminal
        ? `${message}; automatic retry disabled because the paid request may have reached the provider`
        : message,
      providerCostUsd:
        executionResult?.providerCostUsd ??
        (paidCallAttempted ? claimed.job.estimatedProviderCostUsd : 0),
      infrastructureCostUsd:
        executionResult?.infrastructureCostUsd ??
        (paidCallAttempted ? claimed.job.estimatedInfrastructureCostUsd : 0),
      terminal
    });
    throw error;
  }
}
