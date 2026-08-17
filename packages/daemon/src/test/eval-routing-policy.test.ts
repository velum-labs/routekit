import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  RoutingAreaDefinition
} from "@velum-labs/routekit-eval-contracts";
import { makeRoutingSnapshotStoreV2 } from "@velum-labs/routekit-eval-store/effect";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import {
  evalRoutingSnapshotDirectory,
  makeCompositionalRoutingPolicyReader
} from "../eval-routing-policy.js";

test("daemon compositional reader observes publications and falls back to previous", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-daemon-compositional-policy-"));
  const areas: RoutingAreaDefinition[] = [
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
    definitionSetDigest: "definitions-v2",
    evidenceDigest,
    areas,
    candidateModels: ["openai/model"],
    evidence: areas.map((area) => ({
      model: "openai/model",
      areaId: area.id,
      suiteDigest: `suite-${area.id}`,
      evidenceDigest: `${evidenceDigest}-${area.id}`,
      quality: { passRate: 1, lowerConfidenceBound: 0.8, sampleCount: 5 },
      failureRate: 0,
      p95DurationMs: 100,
      unpricedCalls: 5
    }))
  });
  try {
    const reader = makeCompositionalRoutingPolicyReader(home);
    assert.equal(await runRouteKitEffect(reader.getSnapshot()), undefined);
    const store = makeRoutingSnapshotStoreV2(evalRoutingSnapshotDirectory(home));
    await runRouteKitEffect(store.publish(publication("first")));
    await runRouteKitEffect(store.publish(publication("second")));
    assert.equal((await runRouteKitEffect(reader.getSnapshot()))?.evidenceDigest, "second");

    writeFileSync(
      join(evalRoutingSnapshotDirectory(home), "published-routing.v2.json"),
      '{"version":2}'
    );
    assert.equal((await runRouteKitEffect(reader.getSnapshot()))?.evidenceDigest, "first");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
