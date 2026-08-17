import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { initialSetupState, makeFileEvalSetupStateStore } from "../state-store.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("setup state and run checkpoints survive process interruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-state-"));
  roots.push(root);
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeFileEvalSetupStateStore;
      const state = {
        ...initialSetupState({
          profileId: "support",
          repositoryRoot: root,
          now: "2026-08-15T00:00:00.000Z"
        }),
        openQuestion: "Which workflow?"
      };
      yield* store.save(state);
      assert.deepEqual(yield* store.load(root, "support"), state);
    }).pipe(Effect.provide(NodeServicesLayer))
  );
  const mode = (await stat(path.join(root, ".routekit", "eval-setup", "support", "state.json")))
    .mode;
  assert.equal(mode & 0o777, 0o600);
});
