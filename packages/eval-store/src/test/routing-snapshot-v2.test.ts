import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelAreaEvidence, RoutingAreaDefinition } from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { makeRoutingSnapshotStore } from "../routing-snapshot.js";
import {
  makeRoutingSnapshotStoreV2,
  ROUTING_SNAPSHOT_V2_MAX_BYTES,
  type RoutingSnapshotV2Publication
} from "../routing-snapshot-v2.js";

const areas: RoutingAreaDefinition[] = [
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

function evidence(model: string, areaId: string): ModelAreaEvidence {
  return {
    model,
    areaId,
    suiteDigest: `suite-${areaId}`,
    evidenceDigest: `evidence-${model}-${areaId}`,
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

function publication(evidenceDigest: string): RoutingSnapshotV2Publication {
  const candidateModels = ["openai/model-a", "openai/model-b"];
  return {
    definitionSetDigest: "definition-set-v2",
    evidenceDigest,
    areas,
    candidateModels,
    evidence: candidateModels.flatMap((model) => areas.map((area) => evidence(model, area.id)))
  };
}

test("v2 snapshots publish atomically and retain the previous complete matrix", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-v2-"));
  try {
    const store = makeRoutingSnapshotStoreV2(root);
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

test("v1 and v2 snapshot generations remain independent", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-v2-independent-"));
  try {
    await runRouteKitEffect(
      makeRoutingSnapshotStore(root).publish({
        version: 1,
        profileId: "support",
        selectedModel: "openai/model-a",
        fallbackModels: [],
        objective: "highest-quality",
        suiteDigest: "suite-support",
        evidenceDigest: "evidence-support",
        evidence: [
          {
            model: "openai/model-a",
            sampleCount: 1,
            passedCount: 1,
            failedCount: 0,
            unknownCount: 0,
            cutoffCount: 0,
            passRate: 1
          }
        ],
        rejected: []
      })
    );
    await runRouteKitEffect(makeRoutingSnapshotStoreV2(root).publish(publication("evidence-v2")));

    assert.equal((await runRouteKitEffect(makeRoutingSnapshotStore(root).read()))?.version, 1);
    assert.equal((await runRouteKitEffect(makeRoutingSnapshotStoreV2(root).read()))?.version, 2);
    assert.equal(
      readFileSync(join(root, "published-routing.v1.json"), "utf8").includes('"version": 1'),
      true
    );
    assert.equal(
      readFileSync(join(root, "published-routing.v2.json"), "utf8").includes('"version": 2'),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 publication rejects incomplete matrices without rotating the current snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-v2-incomplete-"));
  try {
    const store = makeRoutingSnapshotStoreV2(root);
    await runRouteKitEffect(store.publish(publication("known-good")));
    const complete = publication("incomplete");
    const invalid = {
      ...complete,
      evidence: complete.evidence.slice(0, -1)
    };

    await assert.rejects(runRouteKitEffect(store.publish(invalid)), /missing model-area evidence/);
    assert.equal((await runRouteKitEffect(store.read()))?.evidenceDigest, "known-good");
    assert.equal(await runRouteKitEffect(store.readPrevious()), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 readers reject corrupt and oversized snapshot files", async () => {
  const corruptRoot = mkdtempSync(join(tmpdir(), "routekit-routing-v2-corrupt-"));
  const largeRoot = mkdtempSync(join(tmpdir(), "routekit-routing-v2-large-"));
  try {
    writeFileSync(join(corruptRoot, "published-routing.v2.json"), '{"version":2}');
    await assert.rejects(
      runRouteKitEffect(makeRoutingSnapshotStoreV2(corruptRoot).read()),
      /snapshot is corrupt/
    );

    writeFileSync(
      join(largeRoot, "published-routing.v2.json"),
      "x".repeat(ROUTING_SNAPSHOT_V2_MAX_BYTES + 1)
    );
    await assert.rejects(
      runRouteKitEffect(makeRoutingSnapshotStoreV2(largeRoot).read()),
      /snapshot exceeds/
    );
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true });
    rmSync(largeRoot, { recursive: true, force: true });
  }
});

test("concurrent v2 publishers serialize complete generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-v2-concurrent-"));
  try {
    const first = makeRoutingSnapshotStoreV2(root);
    const second = makeRoutingSnapshotStoreV2(root);
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
