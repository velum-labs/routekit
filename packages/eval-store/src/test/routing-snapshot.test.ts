import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CompiledRoutingPolicy } from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { makeRoutingSnapshotStore } from "../routing-snapshot.js";

function policy(profileId: string, selectedModel: string): CompiledRoutingPolicy {
  return {
    version: 1,
    profileId,
    selectedModel,
    fallbackModels: ["anthropic/fallback"],
    objective: "lowest-cost",
    suiteDigest: "suite-digest",
    evidenceDigest: `evidence-${profileId}`,
    evidence: [],
    rejected: []
  };
}

test("routing snapshots publish atomically and retain the last known good document", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-"));
  try {
    const store = makeRoutingSnapshotStore(root);
    assert.equal(await runRouteKitEffect(store.read()), undefined);
    const first = await runRouteKitEffect(store.publish(policy("support", "openai/cheap")));
    assert.equal(first.profiles.support?.selectedModel, "openai/cheap");
    const second = await runRouteKitEffect(store.publish(policy("extract", "google/fast")));
    assert.equal(second.profiles.support?.selectedModel, "openai/cheap");
    assert.equal(second.profiles.extract?.selectedModel, "google/fast");
    assert.equal(
      (await runRouteKitEffect(store.readPrevious()))?.profiles.support?.selectedModel,
      "openai/cheap"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("published routing snapshots exclude raw evidence and credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-"));
  try {
    const store = makeRoutingSnapshotStore(root);
    await runRouteKitEffect(store.publish(policy("support", "openai/cheap")));
    const raw = readFileSync(join(root, "published-routing.v1.json"), "utf8");
    assert.equal(raw.includes("token"), false);
    assert.equal(raw.includes("candidateOutput"), false);
    assert.equal(raw.includes("evidence\":"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt snapshots fail instead of silently replacing the last known policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-"));
  try {
    writeFileSync(join(root, "published-routing.v1.json"), "{\"version\":1}");
    const store = makeRoutingSnapshotStore(root);
    await assert.rejects(runRouteKitEffect(store.read()), /snapshot is corrupt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
