import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CompiledRoutingPolicy } from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

import { makeRoutingSnapshotStore, ROUTING_SNAPSHOT_MAX_BYTES } from "../routing-snapshot.js";

function policy(profileId: string, selectedModel: string): CompiledRoutingPolicy {
  return {
    version: 1,
    profileId,
    selectedModel,
    fallbackModels: [],
    objective: "lowest-cost",
    suiteDigest: "suite-digest",
    evidenceDigest: `evidence-${profileId}`,
    evidence: [
      {
        model: selectedModel,
        sampleCount: 2,
        passedCount: 2,
        failedCount: 0,
        unknownCount: 0,
        cutoffCount: 0,
        passRate: 1,
        averageJudgeScore: 0.95
      }
    ],
    rejected: [],
    description: `${profileId} routing profile`
  };
}

test("routing snapshots publish atomically and retain the last known good document", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-"));
  try {
    const store = makeRoutingSnapshotStore(root);
    assert.equal(await runRouteKitEffect(store.read()), undefined);
    const first = await runRouteKitEffect(store.publish(policy("support", "openai/cheap")));
    assert.equal(first.profiles.support?.selectedModel, "openai/cheap");
    assert.equal(first.profiles.support?.description, "support routing profile");
    assert.equal(first.profiles.support?.evidence?.[0]?.passRate, 1);
    assert.equal("sampleCount" in (first.profiles.support?.evidence?.[0] ?? {}), false);
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

test("published routing snapshots exclude raw cases and credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-"));
  try {
    const store = makeRoutingSnapshotStore(root);
    await runRouteKitEffect(store.publish(policy("support", "openai/cheap")));
    const raw = readFileSync(join(root, "published-routing.v1.json"), "utf8");
    assert.equal(raw.includes("token"), false);
    assert.equal(raw.includes("candidateOutput"), false);
    assert.equal(raw.includes("judgeOutput"), false);
    assert.match(raw, /"passRate": 1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt snapshots fail instead of silently replacing the last known policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-"));
  try {
    writeFileSync(join(root, "published-routing.v1.json"), '{"version":1}');
    const store = makeRoutingSnapshotStore(root);
    await assert.rejects(runRouteKitEffect(store.read()), /snapshot is corrupt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication rejects inconsistent compiled evidence before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-invalid-"));
  try {
    const valid = policy("support", "openai/cheap");
    const invalid = {
      ...valid,
      evidence: [{ ...valid.evidence[0]!, sampleCount: 3 }]
    };
    const store = makeRoutingSnapshotStore(root);
    await assert.rejects(runRouteKitEffect(store.publish(invalid)), /counts do not sum/);
    assert.equal(await runRouteKitEffect(store.read()), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized snapshots fail before parsing online policy data", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-large-"));
  try {
    writeFileSync(
      join(root, "published-routing.v1.json"),
      "x".repeat(ROUTING_SNAPSHOT_MAX_BYTES + 1)
    );
    await assert.rejects(
      runRouteKitEffect(makeRoutingSnapshotStore(root).read()),
      /snapshot exceeds/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication rejects a profile set that would disable online classification", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-limit-"));
  try {
    const store = makeRoutingSnapshotStore(root);
    for (let index = 0; index < 64; index += 1) {
      await runRouteKitEffect(
        store.publish(policy(`profile-${String(index)}`, `openai/model-${String(index)}`))
      );
    }
    await assert.rejects(
      runRouteKitEffect(store.publish(policy("profile-64", "openai/model-64"))),
      /basis exceeds 64 profiles/
    );
    assert.equal(Object.keys((await runRouteKitEffect(store.read()))?.profiles ?? {}).length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent publishers preserve both profiles", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-routing-snapshot-concurrent-"));
  try {
    const first = makeRoutingSnapshotStore(root);
    const second = makeRoutingSnapshotStore(root);
    await Promise.all([
      runRouteKitEffect(first.publish(policy("frontend", "openai/frontend"))),
      runRouteKitEffect(second.publish(policy("backend", "openai/backend")))
    ]);
    assert.deepEqual(Object.keys((await runRouteKitEffect(first.read()))?.profiles ?? {}).sort(), [
      "backend",
      "frontend"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
