import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-config";
import { ControlError } from "@velum-labs/routekit-runtime";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import { createCliproxySidecar } from "../cliproxy-sidecar.js";
import { DaemonRuntimeState } from "../daemon-runtime-state.js";

const config = parseRouterConfig({ providers: {} });

test("daemon runtime-state mutations serialize on the shared tail", async () => {
  const state = new DaemonRuntimeState({
    config,
    document: "providers: {}\n",
    revisions: { config: 1, accounts: 1, daemon: 1 }
  });
  const order: number[] = [];
  await runRouteKitEffect(
    Effect.all(
      [
        state.serializeEffect(
          Effect.gen(function* () {
            yield* Effect.sleep("20 millis");
            order.push(1);
          })
        ),
        state.serializeEffect(
          Effect.sync(() => {
            order.push(2);
          })
        )
      ],
      { concurrency: "unbounded" }
    )
  );
  assert.deepEqual(order, [1, 2]);
  assert.equal(state.snapshot().configRevision, 1);
});

test("paused daemon runtime state rejects mutations", async () => {
  const state = new DaemonRuntimeState({
    config,
    document: "providers: {}\n",
    revisions: { config: 1, accounts: 1, daemon: 1 }
  });
  state.pause();
  await assert.rejects(
    runRouteKitEffect(state.serializeEffect(Effect.void)),
    (error: unknown) => error instanceof ControlError && error.code === "unavailable"
  );
});

test("sidecar supervisor closes exactly once from an Effect scope", async () => {
  const sidecar = createCliproxySidecar({
    env: { ROUTEKIT_CLIPROXY_BASE_URL: "http://example.invalid" }
  });
  await runRouteKitEffect(
    Effect.scoped(
      Effect.acquireRelease(Effect.succeed(sidecar), (owned) =>
        owned.close().pipe(Effect.ignore)
      ).pipe(
        Effect.tap((owned) =>
          Effect.sync(() => {
            assert.equal(owned.managed(), false);
          })
        )
      )
    )
  );
  await runRouteKitEffect(sidecar.close());
});

test("sidecar reports unmanaged when an external URL is set", async () => {
  const sidecar = createCliproxySidecar({
    env: { ROUTEKIT_CLIPROXY_BASE_URL: "http://127.0.0.1:9" }
  });
  assert.equal(sidecar.managed(), false);
  await runRouteKitEffect(sidecar.close());
});
