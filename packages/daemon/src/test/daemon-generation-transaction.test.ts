import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RouteKitControlClient } from "@velum-labs/routekit-control";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import type { DaemonGenerationStage } from "../daemon-generations.js";
import { readDaemonRevisions } from "../daemon-state.js";
import { startRouteKitDaemon } from "../index.js";
import { mockProvider } from "./daemon-fixtures.js";

const INITIAL_DOCUMENT =
  "providers:\n  openai:\n    strategy: sticky\ndefaultModel: openai/mock-model\n";
const NEXT_DOCUMENT =
  "providers:\n  openai:\n    strategy: round_robin\ndefaultModel: openai/other-model\n";

test("generation transaction rolls back every pre-publication stage and keeps retirement best-effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-daemon-generation-transaction-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "router.yaml");
  writeFileSync(configPath, INITIAL_DOCUMENT);
  const upstream = await mockProvider([
    { id: "mock-model", object: "model" },
    { id: "other-model", object: "model" }
  ]);
  let injectedStage: DaemonGenerationStage | undefined;
  let stages: DaemonGenerationStage[] = [];
  const daemon = await startRouteKitDaemon({
    packageVersion: "1.2.3",
    stateHome,
    configPath,
    port: 0,
    portless: false,
    drainGraceMs: 25,
    onGenerationStage: (stage) => {
      stages.push(stage);
      if (stage !== injectedStage) return;
      injectedStage = undefined;
      throw new Error(`injected ${stage} failure`);
    },
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: stateHome,
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: upstream.url,
      ROUTEKIT_PORTLESS: "0"
    }
  });
  try {
    const client = new RouteKitControlClient({
      url: daemon.record.url,
      token: daemon.record.controlToken!
    });
    const original = await runRouteKitEffect(client.call("config.get", {}));
    const originalRevisions = readDaemonRevisions(stateHome);

    for (const [stage, expectedStages] of [
      ["prepare", ["prepare"]],
      ["validate", ["prepare", "validate"]],
      ["persist", ["prepare", "validate", "persist"]],
      ["commit", ["prepare", "validate", "persist", "commit"]]
    ] as const) {
      stages = [];
      injectedStage = stage;
      await assert.rejects(
        runRouteKitEffect(
          client.call("config.update", {
            expectedRevision: original.revision,
            document: NEXT_DOCUMENT
          })
        )
      );
      assert.deepEqual(stages, expectedStages);
      assert.deepEqual(await runRouteKitEffect(client.call("config.get", {})), original);
      assert.equal(readFileSync(configPath, "utf8"), INITIAL_DOCUMENT);
      assert.deepEqual(readDaemonRevisions(stateHome), originalRevisions);
      assert.equal((await fetch(`${daemon.dataUrl}/health`)).status, 200);
      assert.equal(
        (await runRouteKitEffect(client.call("models.list", {}))).defaultModel,
        "openai/mock-model"
      );
    }

    stages = [];
    injectedStage = "retire";
    const committed = await runRouteKitEffect(
      client.call("config.update", {
        expectedRevision: original.revision,
        document: NEXT_DOCUMENT
      })
    );
    assert.equal(committed.revision, original.revision + 1);
    assert.deepEqual(stages, ["prepare", "validate", "persist", "commit", "retire"]);
    assert.match(readFileSync(configPath, "utf8"), /strategy: round_robin/);
    assert.match(readFileSync(configPath, "utf8"), /defaultModel: openai\/other-model/);
    assert.equal(
      (await runRouteKitEffect(client.call("models.list", {}))).defaultModel,
      "openai/other-model"
    );
    assert.equal((await fetch(`${daemon.dataUrl}/health`)).status, 200);
  } finally {
    await daemon.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
