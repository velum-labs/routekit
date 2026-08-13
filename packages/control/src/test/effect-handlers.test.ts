import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRouteKitRuntime } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import type { EffectRouteKitControlHandlers } from "../effect-api.js";
import { toPromiseControlHandlers } from "../effect-api.js";

test("Effect control handlers run through the process runtime onto control.v2", async () => {
  const runtime = makeRouteKitRuntime();
  try {
    const handlers = toPromiseControlHandlers(
      new Proxy(
        {},
        {
          get: () => () => Effect.succeed({ checks: [{ name: "ok", ok: true }] })
        }
      ) as EffectRouteKitControlHandlers,
      runtime
    );
    const result = await handlers["doctor.run"](
      {},
      { signal: new AbortController().signal, requestId: "request" }
    );
    assert.deepEqual(result, { checks: [{ name: "ok", ok: true }] });
  } finally {
    await runtime.dispose();
  }
});

test("Effect control handler interruption does not require a protocol change", async () => {
  const runtime = makeRouteKitRuntime();
  try {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const handlers = toPromiseControlHandlers(
      new Proxy(
        {},
        {
          get: () => () =>
            Effect.gen(function* () {
              resolveStarted();
              return yield* Effect.never;
            })
        }
      ) as EffectRouteKitControlHandlers,
      runtime
    );
    const controller = new AbortController();
    const pending = Promise.resolve(
      handlers["doctor.run"]({}, { signal: controller.signal, requestId: "request" })
    );
    await started;
    controller.abort();
    await assert.rejects(pending);
  } finally {
    await runtime.dispose();
  }
});
