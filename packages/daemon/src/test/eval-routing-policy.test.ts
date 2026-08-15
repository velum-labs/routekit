import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CompiledRoutingPolicy } from "@velum-labs/routekit-eval-contracts";
import { makeRoutingSnapshotStore } from "@velum-labs/routekit-eval-store/effect";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import {
  evalRoutingSnapshotDirectory,
  makeEvalRoutingPolicyReader
} from "../eval-routing-policy.js";

const supportPolicy: CompiledRoutingPolicy = {
  version: 1,
  profileId: "support",
  selectedModel: "openai/cheap",
  fallbackModels: ["anthropic/fallback"],
  objective: "lowest-cost",
  suiteDigest: "suite",
  evidenceDigest: "evidence",
  evidence: [],
  rejected: []
};

test("daemon policy reader observes atomically published eval profiles without restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-daemon-eval-policy-"));
  try {
    const reader = makeEvalRoutingPolicyReader(home);
    assert.equal(await runRouteKitEffect(reader.getProfile("support")), undefined);

    const store = makeRoutingSnapshotStore(evalRoutingSnapshotDirectory(home));
    await runRouteKitEffect(store.publish(supportPolicy));

    assert.deepEqual(await runRouteKitEffect(reader.getProfile("support")), {
      selectedModel: "openai/cheap",
      fallbackModels: ["anthropic/fallback"],
      objective: "lowest-cost",
      suiteDigest: "suite",
      evidenceDigest: "evidence",
      publishedAt: (await runRouteKitEffect(store.read()))?.profiles.support?.publishedAt
    });
    assert.equal(await runRouteKitEffect(reader.getProfile("missing")), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
