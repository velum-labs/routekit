import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { toPromiseControlHandlers } from "../effect-api.js";
import type { EffectRouteKitControlHandlers } from "../effect-api.js";

test("Effect control handlers keep the Promise control.v2 façade", async () => {
  const handlers = toPromiseControlHandlers(
    new Proxy(
      {},
      {
        get: () => () => Effect.succeed({ checks: [{ name: "ok", ok: true }] })
      }
    ) as EffectRouteKitControlHandlers
  );
  const result = await handlers["doctor.run"](
    {},
    { signal: new AbortController().signal, requestId: "request" }
  );
  assert.deepEqual(result, { checks: [{ name: "ok", ok: true }] });
});

test("Effect control handler interruption does not require a protocol change", async () => {
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
            yield* Effect.never;
            return { checks: [] };
          })
      }
    ) as EffectRouteKitControlHandlers
  );
  const controller = new AbortController();
  const pending = Promise.resolve(
    handlers["doctor.run"]({}, { signal: controller.signal, requestId: "request" })
  );
  await started;
  controller.abort();
  await assert.rejects(pending);
});
