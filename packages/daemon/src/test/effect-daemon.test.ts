import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import { ControlError } from "@velum-labs/routekit-runtime";
import { Effect } from "effect";

import { DaemonRuntimeState } from "../daemon-runtime-state.js";
import {
  makeEffectCliproxySidecar,
  makeEffectDaemonRuntimeState,
  scopedCliproxySidecar
} from "../effect-api.js";

const config = parseRouterConfig({ providers: {} });

test("daemon runtime-state mutations serialize on the shared tail", async () => {
  const state = makeEffectDaemonRuntimeState(
    new DaemonRuntimeState({
      config,
      document: "providers: {}\n",
      revisions: { config: 1, accounts: 1, daemon: 1 }
    })
  );
  const order: number[] = [];
  await Effect.runPromise(
    Effect.all(
      [
        state.serializeMutation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(1);
        }),
        state.serializeMutation(async () => {
          order.push(2);
        })
      ],
      { concurrency: "unbounded" }
    )
  );
  assert.deepEqual(order, [1, 2]);
  const snapshot = await Effect.runPromise(state.snapshot());
  assert.equal(snapshot.configRevision, 1);
});

test("paused daemon runtime state rejects mutations", async () => {
  const state = makeEffectDaemonRuntimeState(
    new DaemonRuntimeState({
      config,
      document: "providers: {}\n",
      revisions: { config: 1, accounts: 1, daemon: 1 }
    })
  );
  await Effect.runPromise(state.pause());
  await assert.rejects(
    Effect.runPromise(state.serializeMutation(async () => undefined)),
    (error: unknown) => error instanceof ControlError && error.code === "unavailable"
  );
});

test("sidecar supervisor closes exactly once from an Effect scope", async () => {
  const sidecar = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owned = yield* scopedCliproxySidecar({
          env: { ROUTEKIT_CLIPROXY_BASE_URL: "http://example.invalid" }
        });
        assert.equal(yield* owned.managed(), false);
        return owned.inner;
      })
    )
  );
  await sidecar.close();
});

test("sidecar Effect façade reports unmanaged when an external URL is set", async () => {
  const sidecar = makeEffectCliproxySidecar({
    env: { ROUTEKIT_CLIPROXY_BASE_URL: "http://127.0.0.1:9" }
  });
  assert.equal(await Effect.runPromise(sidecar.managed()), false);
  await Effect.runPromise(sidecar.close());
});
