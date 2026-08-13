import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import {
  runHostGenerationTransaction,
  type HostGenerationStage
} from "../host-generation-transaction.js";
import { runHostGenerationTransactionEffect } from "../effect-api.js";

test("host generation rolls back every pre-publication stage", async () => {
  for (const injected of ["prepare", "validate", "persist", "commit"] as const) {
    const stages: HostGenerationStage[] = [];
    let rolledBack: string | undefined;
    await assert.rejects(
      runHostGenerationTransaction({
        onStage: (stage) => {
          stages.push(stage);
          if (stage === injected) throw new Error(`injected ${stage} failure`);
        },
        prepare: async () => "candidate",
        validate: async () => undefined,
        persist: () => undefined,
        commit: () => "published",
        rollback: async (candidate) => {
          rolledBack = candidate === undefined ? "none" : candidate;
        },
        retire: () => {
          throw new Error("retire must not run after rollback");
        }
      })
    );
    assert.equal(rolledBack, injected === "prepare" ? "none" : "candidate");
    assert.equal(stages.at(-1), injected);
  }
});

test("host generation retirement stays best-effort after commit", async () => {
  const stages: HostGenerationStage[] = [];
  const result = await runHostGenerationTransaction({
    onStage: (stage) => {
      stages.push(stage);
    },
    prepare: async () => "candidate",
    validate: async () => undefined,
    persist: () => undefined,
    commit: () => "published",
    rollback: async () => {
      throw new Error("rollback must not run after commit");
    },
    retire: () => {
      throw new Error("injected retire failure");
    }
  });
  assert.equal(result, "published");
  assert.deepEqual(stages, ["prepare", "validate", "persist", "commit", "retire"]);
});

test("host generation Effect façade preserves rollback on prepare failure", async () => {
  let rolledBack = false;
  await assert.rejects(
    Effect.runPromise(
      runHostGenerationTransactionEffect({
        prepare: async () => {
          throw new Error("spawn failed");
        },
        validate: async () => undefined,
        persist: () => undefined,
        commit: () => "published",
        rollback: async () => {
          rolledBack = true;
        },
        retire: () => undefined
      })
    )
  );
  assert.equal(rolledBack, true);
});
