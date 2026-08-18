import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  WorkloadDimension
} from "@velum-labs/routekit-eval-contracts";
import { makeRoutingActivationStore } from "@velum-labs/routekit-eval-store/effect";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import {
  evalRoutingSnapshotDirectory,
  makeCompositionalRoutingPolicyReader
} from "../eval-routing-policy.js";

test("daemon compositional reader observes publications and falls back to previous", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-daemon-compositional-policy-"));
  const dimensions: WorkloadDimension[] = [
    "code-change",
    "repository-navigation",
    "verification-debugging",
    "architecture-design",
    "technical-explanation"
  ].map((id) => ({
    id,
    description: `Tasks centered on ${id}`,
    includes: [`Includes ${id}`],
    excludes: [`Excludes work outside ${id}`]
  }));
  const publication = (evidenceDigest: string) => ({
    basisDigest: "definitions-v2",
    evidenceDigest,
    classifierModel: "openai/classifier",
    objective: { kind: "highest-quality" as const },
    maximumUnknownWeight: 0.2,
    dimensions,
    candidateModels: ["openai/model"],
    evidence: dimensions.map((dimension) => ({
      model: "openai/model",
      dimensionId: dimension.id,
      suiteDigest: `suite-${dimension.id}`,
      evidenceDigest: `${evidenceDigest}-${dimension.id}`,
      quality: { passRate: 1, lowerConfidenceBound: 0.8, sampleCount: 5 },
      failureRate: 0,
      p95DurationMs: 100,
      unpricedCalls: 5
    }))
  });
  try {
    const reader = makeCompositionalRoutingPolicyReader(home);
    assert.equal(await runRouteKitEffect(reader.getSnapshot()), undefined);
    const store = makeRoutingActivationStore(evalRoutingSnapshotDirectory(home));
    await runRouteKitEffect(store.publish(publication("first")));
    await runRouteKitEffect(store.publish(publication("second")));
    assert.equal((await runRouteKitEffect(reader.getSnapshot()))?.evidenceDigest, "second");

    writeFileSync(
      join(evalRoutingSnapshotDirectory(home), "published-routing.json"),
      '{"version":2}'
    );
    assert.equal((await runRouteKitEffect(reader.getSnapshot()))?.evidenceDigest, "first");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
