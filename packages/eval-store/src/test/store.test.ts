import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVAL_CONTRACT_VERSION, type EvalRunResult } from "@velum-labs/routekit-eval-contracts";
import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { LocalArtifactStore } from "../artifacts.js";
import { LocalExperimentLedger } from "../experiment-ledger.js";
import { makeEvalStore } from "../store.js";

function sample(runId: string): EvalRunResult {
  return {
    version: EVAL_CONTRACT_VERSION,
    runId,
    suiteId: "suite",
    candidateModel: "openai/gpt-4o-mini",
    judgeModel: "openai/gpt-4o-mini",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    passed: 1,
    failed: 0,
    cases: [{ caseId: "c1", candidateOutput: "ok", passed: true }]
  };
}

test("raw eval runs are write-once and missing stays distinct from corrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-store-"));
  try {
    const store = makeEvalStore(root);
    const first = sample("run-1");
    await runRouteKitEffect(store.writeRawRun(first));
    assert.deepEqual(await runRouteKitEffect(store.readRawRun("run-1")), first);
    assert.equal(await runRouteKitEffect(store.readRawRun("missing")), undefined);
    await assert.rejects(runRouteKitEffect(store.writeRawRun(first)), /immutable/);
    const evidence = await runRouteKitEffect(store.publish(first));
    assert.equal(evidence.runId, "run-1");
    assert.equal((await runRouteKitEffect(store.readPublished()))?.runId, "run-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function experimentManifest(): unknown {
  return {
    schemaVersion: 1,
    experimentId: "local-platform-test",
    objective: "Verify resumable local experiment state",
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
          id: "local",
          executor: "local",
          configuration: { method: "embedding_knn" },
          command: { executable: "node", args: ["runner.js"] },
          estimatedInfrastructureCostUsd: 0.1
        }
      ],
      seeds: [181081]
    },
    tasks: [{ id: "task-1", inputArtifact: "inputs/task-1.json" }],
    schedule: {
      type: "paired_interleave",
      maximumHostedCallsInFlight: 0,
      maximumSandboxes: 0
    },
    selection: {
      primaryMetric: "area_brier",
      secondaryMetrics: [],
      maximumPromotedTreatments: 1
    },
    budget: { providerMaximumUsd: 0, vercelMaximumUsd: 0.2 },
    dataAccess: { lockedTest: false }
  };
}

test("content-addressed artifacts deduplicate and verify bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-artifacts-"));
  try {
    const store = new LocalArtifactStore(root);
    const first = await store.put('{"answer":42}\n', {
      kind: "predictions",
      contentType: "application/json"
    });
    const second = await store.put('{"answer":42}\n', {
      kind: "predictions",
      contentType: "application/json"
    });
    assert.deepEqual(second, first);
    assert.equal(new TextDecoder().decode(await store.get(first)), '{"answer":42}\n');
    assert.match(first.pathname, /^predictions\/sha256\//);
    await assert.rejects(
      store.get({ ...first, pathname: `../${first.pathname}` }),
      /escapes the artifact root/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local experiment ledger is idempotent, resumable, and budget guarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    const artifacts = new LocalArtifactStore(join(root, "artifacts"));
    await ledger.initialize();
    const plan = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
    const created = await ledger.createExperiment(plan);
    assert.equal(created.experiment.status, "awaiting_approval");
    assert.equal((await ledger.createExperiment(plan)).jobs.length, 1);
    await ledger.approve(plan.manifest.experimentId, "paid_execution", "test-user");
    const queued = await ledger.queuePendingJobs(plan.manifest.experimentId);
    assert.equal(queued.length, 1);
    const job = queued[0]!;
    const claimed = await ledger.claimJob(job.job.id, "worker-1", 60_000);
    assert.equal(claimed?.status, "running");
    assert.equal(await ledger.claimJob(job.job.id, "worker-2", 60_000), undefined);
    assert.equal(await ledger.heartbeatJob(job.job.id, "worker-2", 60_000), false);
    assert.equal(await ledger.heartbeatJob(job.job.id, "worker-1", 60_000), true);
    const output = await artifacts.put('{"prediction":"area-a"}\n', {
      kind: "runs",
      contentType: "application/json"
    });
    await ledger.completeJob(job.job.id, {
      workerId: "worker-1",
      outputArtifact: output,
      providerCostUsd: 0,
      infrastructureCostUsd: 0.08,
      latencyMs: 123
    });
    const snapshot = await ledger.getExperiment(plan.manifest.experimentId);
    assert.equal(snapshot?.jobs[0]?.status, "succeeded");
    assert.equal(snapshot?.experiment.infrastructureSpentUsd, 0.08);
    assert.equal(snapshot?.experiment.infrastructureReservedUsd, 0);
    const metrics = await artifacts.put('{"areaHitAt1":1}\n', {
      kind: "metrics",
      contentType: "application/json"
    });
    await ledger.attachMetrics(plan.manifest.experimentId, metrics);
    assert.deepEqual(
      (await ledger.getExperiment(plan.manifest.experimentId))?.experiment.metricsArtifact,
      metrics
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual cost overruns are recorded and stop later jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-overrun-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    await ledger.initialize();
    const manifest = experimentManifest() as {
      matrix: { treatments: Array<{ estimatedInfrastructureCostUsd: number }> };
      tasks: Array<{ id: string; inputArtifact: string }>;
    };
    manifest.tasks.push({ id: "task-2", inputArtifact: "inputs/task-2.json" });
    const plan = freezeExperimentPlan(manifest, "2026-08-17T00:00:00.000Z");
    await ledger.createExperiment(plan);
    await ledger.approve(plan.manifest.experimentId, "paid_execution", "test-user");
    const queued = await ledger.queuePendingJobs(plan.manifest.experimentId);
    const first = queued[0]!;
    const second = queued[1]!;
    assert.ok(await ledger.claimJob(first.job.id, "worker-1", 60_000));
    await ledger.completeJob(first.job.id, {
      workerId: "worker-1",
      outputArtifact: {
        digest: "d".repeat(64),
        pathname: `runs/sha256/dd/${"d".repeat(64)}.json`,
        uri: "memory:overrun",
        contentType: "application/json",
        size: 2
      },
      providerCostUsd: 0,
      infrastructureCostUsd: 0.25,
      latencyMs: 10
    });
    assert.equal(await ledger.claimJob(second.job.id, "worker-2", 60_000), undefined);
    const snapshot = await ledger.getExperiment(plan.manifest.experimentId);
    assert.equal(snapshot?.experiment.infrastructureSpentUsd, 0.25);
    assert.equal(snapshot?.jobs[1]?.status, "failed");
    assert.equal(snapshot?.jobs[1]?.attemptCount, 5);
    assert.match(snapshot?.jobs[1]?.error ?? "", /budget exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all required approvals must be recorded before jobs can be claimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-approvals-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    await ledger.initialize();
    const manifest = experimentManifest() as {
      dataset: { role: string };
    };
    manifest.dataset.role = "confirmation";
    const plan = freezeExperimentPlan(manifest, "2026-08-17T00:00:00.000Z");
    const created = await ledger.createExperiment(plan);
    const jobId = created.jobs[0]!.job.id;

    assert.equal(created.experiment.status, "awaiting_approval");
    assert.equal(await ledger.claimJob(jobId, "unauthorized-worker", 60_000), undefined);
    await assert.rejects(ledger.queuePendingJobs(plan.manifest.experimentId), /awaiting_approval/);

    await ledger.approve(plan.manifest.experimentId, "paid_execution", "budget-owner");
    assert.equal(
      (await ledger.getExperiment(plan.manifest.experimentId))?.experiment.status,
      "awaiting_approval"
    );

    await ledger.approve(plan.manifest.experimentId, "confirmation", "data-owner");
    assert.equal(
      (await ledger.getExperiment(plan.manifest.experimentId))?.experiment.status,
      "queued"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job ownership fences stale completion and cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-fencing-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    await ledger.initialize();
    const plan = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
    await ledger.createExperiment(plan);
    await ledger.approve(plan.manifest.experimentId, "paid_execution", "test-user");
    const [queued] = await ledger.queuePendingJobs(plan.manifest.experimentId);
    assert.ok(queued);
    assert.ok(await ledger.claimJob(queued.job.id, "worker-1", 0));
    assert.ok(await ledger.claimJob(queued.job.id, "worker-2", 60_000));

    const outputArtifact = {
      digest: "e".repeat(64),
      pathname: `runs/sha256/ee/${"e".repeat(64)}.json`,
      uri: "memory:fencing",
      contentType: "application/json",
      size: 2
    };
    await assert.rejects(
      ledger.completeJob(queued.job.id, {
        workerId: "worker-1",
        outputArtifact,
        providerCostUsd: 0,
        infrastructureCostUsd: 0.08,
        latencyMs: 10
      }),
      /does not own/
    );

    await ledger.cancelExperiment(plan.manifest.experimentId);
    const cancelled = await ledger.completeJob(queued.job.id, {
      workerId: "worker-2",
      outputArtifact,
      providerCostUsd: 0,
      infrastructureCostUsd: 0.08,
      latencyMs: 10
    });
    assert.equal(cancelled.status, "cancelled");
    const snapshot = await ledger.getExperiment(plan.manifest.experimentId);
    assert.equal(snapshot?.experiment.infrastructureSpentUsd, 0);
    assert.equal(snapshot?.jobs[0]?.status, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal job failures cannot be requeued automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-terminal-failure-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    await ledger.initialize();
    const plan = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
    await ledger.createExperiment(plan);
    await ledger.approve(plan.manifest.experimentId, "paid_execution", "test-user");
    const [queued] = await ledger.queuePendingJobs(plan.manifest.experimentId);
    assert.ok(queued);
    assert.ok(await ledger.claimJob(queued.job.id, "worker-1", 60_000));

    await ledger.failJob(queued.job.id, {
      workerId: "worker-1",
      error: "paid request outcome is ambiguous",
      infrastructureCostUsd: 0.08,
      terminal: true
    });

    assert.deepEqual(await ledger.queuePendingJobs(plan.manifest.experimentId), []);
    const snapshot = await ledger.getExperiment(plan.manifest.experimentId);
    assert.equal(snapshot?.jobs[0]?.status, "failed");
    assert.equal(snapshot?.jobs[0]?.retryable, false);
    assert.equal(snapshot?.jobs[0]?.attemptCount, 1);
    assert.equal(snapshot?.experiment.infrastructureReservedUsd, 0);
    assert.equal(snapshot?.experiment.infrastructureSpentUsd, 0.08);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired paid-call lease fails closed instead of dispatching a duplicate", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-paid-lease-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    await ledger.initialize();
    const plan = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
    await ledger.createExperiment(plan);
    await ledger.approve(plan.manifest.experimentId, "paid_execution", "test-user");
    const [queued] = await ledger.queuePendingJobs(plan.manifest.experimentId);
    assert.ok(queued);
    assert.ok(await ledger.claimJob(queued.job.id, "worker-1", 0));
    assert.equal(await ledger.disableJobRetries(queued.job.id, "worker-1"), true);

    assert.equal(await ledger.claimJob(queued.job.id, "worker-2", 60_000), undefined);
    const snapshot = await ledger.getExperiment(plan.manifest.experimentId);
    assert.equal(snapshot?.jobs[0]?.status, "failed");
    assert.equal(snapshot?.jobs[0]?.retryable, false);
    assert.match(snapshot?.jobs[0]?.error ?? "", /paid request was dispatched/);
    assert.equal(snapshot?.experiment.infrastructureReservedUsd, 0);
    assert.equal(snapshot?.experiment.infrastructureSpentUsd, 0.1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retryable failures can be reclaimed and retain total attempt cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-ledger-retry-"));
  try {
    const ledger = new LocalExperimentLedger(join(root, "ledger.json"));
    await ledger.initialize();
    const plan = freezeExperimentPlan(experimentManifest(), "2026-08-17T00:00:00.000Z");
    await ledger.createExperiment(plan);
    await ledger.approve(plan.manifest.experimentId, "paid_execution", "test-user");
    const [queued] = await ledger.queuePendingJobs(plan.manifest.experimentId);
    assert.ok(queued);
    assert.ok(await ledger.claimJob(queued.job.id, "worker-1", 60_000));
    await ledger.failJob(queued.job.id, {
      workerId: "worker-1",
      error: "transient worker failure",
      infrastructureCostUsd: 0.02
    });

    const retried = await ledger.claimJob(queued.job.id, "worker-2", 60_000);
    assert.equal(retried?.status, "running");
    assert.equal(retried?.attemptCount, 2);
    await ledger.completeJob(queued.job.id, {
      workerId: "worker-2",
      outputArtifact: {
        digest: "f".repeat(64),
        pathname: `runs/sha256/ff/${"f".repeat(64)}.json`,
        uri: "memory:retry",
        contentType: "application/json",
        size: 2
      },
      providerCostUsd: 0,
      infrastructureCostUsd: 0.03,
      latencyMs: 10
    });

    const snapshot = await ledger.getExperiment(plan.manifest.experimentId);
    assert.equal(snapshot?.jobs[0]?.status, "succeeded");
    assert.equal(snapshot?.jobs[0]?.infrastructureCostUsd, 0.05);
    assert.equal(snapshot?.experiment.infrastructureSpentUsd, 0.05);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
