import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  EVAL_CONTRACT_VERSION,
  EVAL_POLICY_BYPASS_HEADER
} from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import {
  aggregateEvalResults,
  evaluateClassificationPredictions,
  expectedExperimentCost,
  extractClassificationPrediction,
  freezeExperimentPlan,
  requiredExperimentApprovalStages,
  runEvalSuite
} from "../effect-api.js";
import { LocalExecutionBackend } from "../execution.js";

test("eval aggregation counts passes and failures", () => {
  assert.deepEqual(
    aggregateEvalResults([
      { caseId: "a", candidateOutput: "yes", passed: true },
      { caseId: "b", candidateOutput: "no", passed: false }
    ]),
    { passed: 1, failed: 1 }
  );
});

test("eval execution uses explicit models and the policy-bypass header", async () => {
  const seen: Array<{ model?: string; bypass?: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
      const bypass = request.headers[EVAL_POLICY_BYPASS_HEADER];
      seen.push({
        model: body.model,
        bypass: Array.isArray(bypass) ? bypass[0] : bypass
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: body.model === "openai/judge-mini" ? "pass" : "the sky is blue"
              }
            }
          ]
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const result = await runRouteKitEffect(
      runEvalSuite(
        {
          version: EVAL_CONTRACT_VERSION,
          id: "suite",
          candidateModel: "openai/candidate-mini",
          judgeModel: "openai/judge-mini",
          cases: [{ id: "c1", prompt: "What color is the sky?", expected: "blue" }]
        },
        { gatewayUrl: `http://127.0.0.1:${address.port}`, token: "eval-token" }
      )
    );
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      seen.map((entry) => entry.model),
      ["openai/candidate-mini", "openai/judge-mini"]
    );
    assert.ok(seen.every((entry) => entry.bypass === "1"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});

test("eval execution rejects auto-router models", async () => {
  await assert.rejects(
    runRouteKitEffect(
      runEvalSuite(
        {
          version: EVAL_CONTRACT_VERSION,
          id: "suite",
          candidateModel: "auto",
          judgeModel: "openai/judge-mini",
          cases: []
        },
        { gatewayUrl: "http://127.0.0.1:9", token: "eval-token" }
      )
    ),
    /explicit provider\/model/
  );
});

function experimentManifest(): unknown {
  return {
    schemaVersion: 1,
    experimentId: "classification-comparison",
    objective: "Compare local and hosted classification",
    code: {
      image: `runner@sha256:${"a".repeat(64)}`,
      sourceCommit: "b".repeat(40)
    },
    dataset: {
      id: "development-v1",
      hash: "c".repeat(64),
      role: "development"
    },
    matrix: {
      treatments: [
        {
          id: "hosted",
          executor: "hosted-model",
          configuration: { model: "openrouter/luna" },
          estimatedProviderCostUsd: 0.01
        },
        {
          id: "local",
          executor: "local",
          configuration: { method: "embedding_knn" },
          command: {
            executable: process.execPath,
            args: ["-e", "process.stdin.pipe(process.stdout)"]
          }
        }
      ],
      seeds: [181081, 206369]
    },
    tasks: [
      { id: "task-b", inputArtifact: "inputs/b.json" },
      { id: "task-a", inputArtifact: "inputs/a.json" }
    ],
    schedule: {
      type: "paired_interleave",
      maximumHostedCallsInFlight: 16,
      maximumSandboxes: 4
    },
    selection: {
      primaryMetric: "area_brier",
      secondaryMetrics: ["area_hit_at_1"],
      maximumPromotedTreatments: 1
    },
    budget: { providerMaximumUsd: 1, vercelMaximumUsd: 1 },
    dataAccess: { lockedTest: false }
  };
}

test("experiment plans are deterministic and paired", () => {
  const first = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
  const second = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
  assert.deepEqual(first, second);
  assert.equal(first.jobs.length, 8);
  assert.deepEqual(
    first.jobs.slice(0, 2).map((job) => [job.taskId, job.treatmentId, job.seed]),
    [
      ["task-a", "hosted", 181081],
      ["task-a", "local", 181081]
    ]
  );
  assert.deepEqual(expectedExperimentCost(first), {
    providerUsd: 0.04,
    infrastructureUsd: 0
  });
  assert.deepEqual(requiredExperimentApprovalStages(first), ["paid_execution"]);
});

test("approval requirements compose paid execution with protected data roles", () => {
  const confirmation = structuredClone(experimentManifest()) as {
    dataset: { role: string };
  };
  confirmation.dataset.role = "confirmation";
  assert.deepEqual(requiredExperimentApprovalStages(freezeExperimentPlan(confirmation)), [
    "paid_execution",
    "confirmation"
  ]);

  const lockedTest = structuredClone(experimentManifest()) as {
    dataset: { role: string };
    dataAccess: { lockedTest: boolean };
  };
  lockedTest.dataset.role = "locked_test";
  lockedTest.dataAccess.lockedTest = true;
  assert.deepEqual(requiredExperimentApprovalStages(freezeExperimentPlan(lockedTest)), [
    "paid_execution",
    "locked_test"
  ]);
});

test("experiment plans reject mutable images, secrets, and auto routing", () => {
  const mutableImage = structuredClone(experimentManifest()) as {
    code: { image: string };
  };
  mutableImage.code.image = "runner:latest";
  assert.throws(() => freezeExperimentPlan(mutableImage), /pinned/);

  const secret = structuredClone(experimentManifest()) as {
    matrix: { treatments: Array<{ configuration: Record<string, unknown> }> };
  };
  secret.matrix.treatments[0]!.configuration.assistance = {
    retriever: { apiKey: "do-not-store-this" }
  };
  assert.throws(() => freezeExperimentPlan(secret), /may contain a secret/);

  const recursive = structuredClone(experimentManifest()) as {
    matrix: { treatments: Array<{ configuration: Record<string, unknown> }> };
  };
  recursive.matrix.treatments[0]!.configuration.model = "auto";
  assert.throws(() => freezeExperimentPlan(recursive), /explicit provider\/model/);

  const underfunded = structuredClone(experimentManifest()) as {
    budget: { providerMaximumUsd: number };
  };
  underfunded.budget.providerMaximumUsd = 0.01;
  assert.throws(() => freezeExperimentPlan(underfunded), /expected provider cost/);

  const taskSecret = structuredClone(experimentManifest()) as {
    tasks: Array<{ metadata?: Record<string, unknown> }>;
  };
  taskSecret.tasks[0]!.metadata = { accessToken: "do-not-store-this" };
  assert.throws(() => freezeExperimentPlan(taskSecret), /may contain a secret/);
});

test("local execution backend passes frozen job input over stdin", async () => {
  const plan = freezeExperimentPlan(experimentManifest());
  const job = plan.jobs.find((candidate) => candidate.treatmentId === "local");
  assert.ok(job);
  const result = await new LocalExecutionBackend().execute(job, {
    input: new TextEncoder().encode('{"task":"classify"}')
  });
  assert.deepEqual(result.output, { task: "classify" });
  assert.equal(result.providerCostUsd, 0);
});

test("classification metrics compare treatments quantitatively", () => {
  const metrics = evaluateClassificationPredictions([
    {
      treatmentId: "embedding",
      taskId: "task-1",
      seed: 1,
      expectedScope: "known",
      expectedArea: "router",
      prediction: {
        scopeProbabilities: { known: 0.9, unknown: 0.1 },
        areaProbabilities: { router: 0.8, gateway: 0.2 },
        rankedAreas: ["router", "gateway"],
        latencyMs: 20,
        providerCostUsd: 0,
        infrastructureCostUsd: 0.001,
        provenance: {
          imageDigest: "a".repeat(64),
          datasetHash: "b".repeat(64),
          configurationHash: "c".repeat(64),
          seed: 1
        }
      }
    },
    {
      treatmentId: "embedding",
      taskId: "task-2",
      seed: 1,
      expectedScope: "known",
      expectedArea: "gateway",
      prediction: {
        scopeProbabilities: { known: 0.4, unknown: 0.6 },
        areaProbabilities: { router: 0.7, gateway: 0.3 },
        rankedAreas: ["router", "gateway"],
        latencyMs: 30,
        providerCostUsd: 0,
        infrastructureCostUsd: 0.001,
        provenance: {
          imageDigest: "a".repeat(64),
          datasetHash: "b".repeat(64),
          configurationHash: "c".repeat(64),
          seed: 1
        }
      }
    }
  ]);
  assert.equal(metrics[0]?.scopeHitAt1?.rate, 0.5);
  assert.equal(metrics[0]?.areaHitAt1?.rate, 0.5);
  assert.equal(metrics[0]?.medianLatencyMs, 25);
  assert.ok(Math.abs((metrics[0]?.meanAreaBrier ?? 0) - 0.53) < 1e-12);
});

test("classification predictions are extracted from worker and hosted-model outputs", () => {
  const prediction = {
    scopeProbabilities: { known: 0.9, unknown: 0.1 },
    areaProbabilities: { router: 0.8, gateway: 0.2 },
    rankedAreas: ["router", "gateway"],
    latencyMs: 20,
    providerCostUsd: 0,
    infrastructureCostUsd: 0.001,
    provenance: {
      imageDigest: "a".repeat(64),
      datasetHash: "b".repeat(64),
      configurationHash: "c".repeat(64),
      seed: 1
    }
  };
  assert.deepEqual(extractClassificationPrediction(prediction), prediction);
  assert.deepEqual(extractClassificationPrediction({ result: prediction }), prediction);
  assert.deepEqual(
    extractClassificationPrediction({
      response: {
        choices: [
          {
            message: {
              content: `\`\`\`json\n${JSON.stringify({ prediction })}\n\`\`\``
            }
          }
        ]
      }
    }),
    prediction
  );
  assert.deepEqual(
    extractClassificationPrediction(
      `\`\`\`json${"\t".repeat(100_000)}${JSON.stringify({ prediction })}\n\`\`\``
    ),
    prediction
  );
  const {
    latencyMs: _latencyMs,
    providerCostUsd: _providerCostUsd,
    infrastructureCostUsd: _infrastructureCostUsd,
    provenance: _provenance,
    ...scores
  } = prediction;
  assert.deepEqual(
    extractClassificationPrediction(
      {
        response: {
          choices: [{ message: { content: JSON.stringify(scores) } }]
        }
      },
      {
        latencyMs: prediction.latencyMs,
        providerCostUsd: prediction.providerCostUsd,
        infrastructureCostUsd: prediction.infrastructureCostUsd,
        provenance: prediction.provenance
      }
    ),
    prediction
  );
});
