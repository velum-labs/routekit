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
          prepare: () => Effect.succeed("candidate"),
          validate: () => Effect.void,
          persist: () => Effect.void,
          commit: () => Effect.succeed("published"),
          rollback: (candidate) =>
            Effect.sync(() => {
              rolledBack = candidate === undefined ? "none" : candidate;
            }),
          retire: () =>
            Effect.fail(new RouteKitFailure({ message: "retire must not run after rollback" }))
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
      prepare: () => Effect.succeed("candidate"),
      validate: () => Effect.void,
      persist: () => Effect.void,
      commit: () => Effect.succeed("published"),
      rollback: () =>
        Effect.fail(new RouteKitFailure({ message: "rollback must not run after commit" })),
      retire: () => Effect.fail(new RouteKitFailure({ message: "injected retire failure" }))
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
        prepare: () => Effect.fail(new RouteKitFailure({ message: "spawn failed" })),
        validate: () => Effect.void,
        persist: () => Effect.void,
        commit: () => Effect.succeed("published"),
        rollback: () =>
          Effect.sync(() => {
            rolledBack = true;
          }),
        retire: () => Effect.void
      })
    )
  );
  assert.equal(rolledBack, true);
});
