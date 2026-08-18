import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  ModelDimensionEvidence,
  WorkloadDimension
} from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import {
  makeRoutingActivationStore,
  ROUTING_ACTIVATION_MAX_BYTES,
  RoutingActivationConflictError,
  type RoutingActivationPublication
} from "../routing-activation.js";

const dimensions: WorkloadDimension[] = [
  "gateway-protocol",
  "eval-routing",
  "account-pooling",
  "typescript-maintenance",
  "release-operations"
].map((id) => ({
  id,
  description: `Requests about ${id}`,
  includes: [`Tasks specifically involving ${id}`],
  excludes: [`Tasks unrelated to ${id}`]
}));

function evidence(model: string, dimensionId: string): ModelDimensionEvidence {
  return {
    model,
    dimensionId,
    suiteDigest: `suite-${dimensionId}`,
    evidenceDigest: `evidence-${model}-${dimensionId}`,
    quality: {
      passRate: 0.9,
      lowerConfidenceBound: 0.7,
      sampleCount: 10
    },
    failureRate: 0.1,
    averageJudgeScore: 0.85,
    p95DurationMs: 1_000,
    unpricedCalls: 10
  };
}

function publication(evidenceDigest: string): RoutingActivationPublication {
  const candidateModels = ["openai/model-a", "openai/model-b"];
  return {
    basisDigest: "routing-basis",
    evidenceDigest,
    classifierModel: "openai/classifier",
    objective: { kind: "highest-quality" },
    maximumUnknownWeight: 0.2,
    dimensions,
    candidateModels,
    evidence: candidateModels.flatMap((model) =>
      dimensions.map((dimension) => evidence(model, dimension.id))
    )
  };
}

test("routing activations publish atomically and retain the previous complete matrix", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-activation-"));
  try {
    const store = makeRoutingActivationStore(root);
    assert.equal(await runRouteKitEffect(store.read()), undefined);
    const first = await runRouteKitEffect(store.publish(publication("evidence-first")));
    assert.equal(first.version, 2);
    assert.equal(first.evidence.length, 10);
    assert.match(first.generatedAt, /^\d{4}-\d{2}-\d{2}T/u);

    await runRouteKitEffect(store.publish(publication("evidence-second")));
    assert.equal((await runRouteKitEffect(store.read()))?.evidenceDigest, "evidence-second");
    assert.equal((await runRouteKitEffect(store.readPrevious()))?.evidenceDigest, "evidence-first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing activation publication uses evidence-digest compare-and-swap", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-activation-cas-"));
  try {
    const store = makeRoutingActivationStore(root);
    const first = await runRouteKitEffect(
      store.publishIfCurrent(publication("evidence-first"), undefined)
    );
    assert.equal(first.evidenceDigest, "evidence-first");

    await assert.rejects(
      runRouteKitEffect(store.publishIfCurrent(publication("evidence-stale"), undefined)),
      (error: unknown) =>
        error instanceof RoutingActivationConflictError &&
        error.expectedEvidenceDigest === undefined &&
        error.actualEvidenceDigest === "evidence-first"
    );
    assert.equal((await runRouteKitEffect(store.read()))?.evidenceDigest, "evidence-first");

    const second = await runRouteKitEffect(
      store.publishIfCurrent(publication("evidence-second"), "evidence-first")
    );
    assert.equal(second.evidenceDigest, "evidence-second");
    assert.equal((await runRouteKitEffect(store.readPrevious()))?.evidenceDigest, "evidence-first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing activation publication rejects incomplete matrices without rotating the current snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-activation-incomplete-"));
  try {
    const store = makeRoutingActivationStore(root);
    await runRouteKitEffect(store.publish(publication("known-good")));
    const complete = publication("incomplete");
    const invalid = {
      ...complete,
      evidence: complete.evidence.slice(0, -1)
    };

    await assert.rejects(
      runRouteKitEffect(store.publish(invalid)),
      /missing model-dimension evidence/
    );
    assert.equal((await runRouteKitEffect(store.read()))?.evidenceDigest, "known-good");
    assert.equal(await runRouteKitEffect(store.readPrevious()), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing activation readers reject corrupt and oversized snapshot files", async () => {
  const corruptRoot = mkdtempSync(join(tmpdir(), "routekit-routing-activation-corrupt-"));
  const largeRoot = mkdtempSync(join(tmpdir(), "routekit-routing-activation-large-"));
  try {
    writeFileSync(join(corruptRoot, "published-routing.json"), '{"version":2}');
    await assert.rejects(
      runRouteKitEffect(makeRoutingActivationStore(corruptRoot).read()),
      /routing activation is corrupt/
    );

    writeFileSync(
      join(largeRoot, "published-routing.json"),
      "x".repeat(ROUTING_ACTIVATION_MAX_BYTES + 1)
    );
    await assert.rejects(
      runRouteKitEffect(makeRoutingActivationStore(largeRoot).read()),
      /routing activation exceeds/
    );
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true });
    rmSync(largeRoot, { recursive: true, force: true });
  }
});

test("concurrent routing activation publishers serialize complete generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-activation-concurrent-"));
  try {
    const first = makeRoutingActivationStore(root);
    const second = makeRoutingActivationStore(root);
    await Promise.all([
      runRouteKitEffect(first.publish(publication("evidence-a"))),
      runRouteKitEffect(second.publish(publication("evidence-b")))
    ]);
    const current = await runRouteKitEffect(first.read());
    const previous = await runRouteKitEffect(first.readPrevious());
    assert.deepEqual(
      new Set([current?.evidenceDigest, previous?.evidenceDigest]),
      new Set(["evidence-a", "evidence-b"])
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
