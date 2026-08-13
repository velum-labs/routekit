import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { scopedTurn } from "../effect-api.js";
import { HarnessError } from "../errors.js";
import { SingleFlightTurnController } from "../lifecycle.js";

test("scoped turns release the one-live-turn lease on scope close", async () => {
  const controller = new SingleFlightTurnController();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* scopedTurn(controller);
        assert.equal(controller.active, true);
        assert.equal(lease.signal.aborted, false);
      })
    )
  );
  assert.equal(controller.active, false);
});

test("incomplete scoped turns abort the native operation", async () => {
  const controller = new SingleFlightTurnController();
  let aborted = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* scopedTurn(controller);
        lease.signal.addEventListener("abort", () => {
          aborted = true;
        });
      })
    )
  );
  assert.equal(aborted, true);
});

test("a second turn still fails while a scoped lease is live", async () => {
  const controller = new SingleFlightTurnController();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scopedTurn(controller);
        assert.throws(() => controller.start(), (error: unknown) => error instanceof HarnessError);
      })
    )
  );
});
