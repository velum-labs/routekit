import assert from "node:assert/strict";
import { test } from "node:test";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { runHostGenerationTransactionEffect } from "../effect-api.js";
import { type HostGenerationStage } from "../host-generation-transaction.js";

test("host generation rolls back every pre-publication stage", async () => {
  for (const injected of ["prepare", "validate", "persist", "commit"] as const) {
    const stages: HostGenerationStage[] = [];
    let rolledBack: string | undefined;
    await assert.rejects(
      Effect.runPromise(
        runHostGenerationTransactionEffect({
          onStage: (stage) => {
            stages.push(stage);
            if (stage === injected)
              throw new RouteKitFailure({ message: `injected ${stage} failure` });
          },
          prepare: async () => "candidate",
          validate: async () => undefined,
          persist: () => undefined,
          commit: () => "published",
          rollback: async (candidate) => {
            rolledBack = candidate === undefined ? "none" : candidate;
          },
          retire: () => {
            throw new RouteKitFailure({ message: "retire must not run after rollback" });
          }
        })
      )
    );
    assert.equal(rolledBack, injected === "prepare" ? "none" : "candidate");
    assert.equal(stages.at(-1), injected);
  }
});

test("host generation retirement stays best-effort after commit", async () => {
  const stages: HostGenerationStage[] = [];
  const result = await Effect.runPromise(
    runHostGenerationTransactionEffect({
      onStage: (stage) => {
        stages.push(stage);
      },
      prepare: async () => "candidate",
      validate: async () => undefined,
      persist: () => undefined,
      commit: () => "published",
      rollback: async () => {
        throw new RouteKitFailure({ message: "rollback must not run after commit" });
      },
      retire: () => {
        throw new RouteKitFailure({ message: "injected retire failure" });
      }
    })
  );
  assert.equal(result, "published");
  assert.deepEqual(stages, ["prepare", "validate", "persist", "commit", "retire"]);
});

test("host generation rolls back on prepare failure", async () => {
  let rolledBack = false;
  await assert.rejects(
    Effect.runPromise(
      runHostGenerationTransactionEffect({
        prepare: async () => {
          throw new RouteKitFailure({ message: "spawn failed" });
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
