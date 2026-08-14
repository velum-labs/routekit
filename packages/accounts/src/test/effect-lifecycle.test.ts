import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, Fiber, Layer } from "effect";
import { AccountActivityCoordinator } from "../activity.js";
import {
  AccountActivity,
  openSubscriptionAccountSet,
  readBoundedSubscriptionBodyEffect,
  scopedRequestLease,
  scopedSubscriptionAccountSet
} from "../effect-api.js";
import { fakeProvider, writeMember } from "./subscription-pool-fixtures.js";

test("scoped account-set construction closes probe resources on scope end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-account-set-"));
  try {
    writeMember(directory, "work", { accessToken: "token-work" });
    const closed = await runRouteKitEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const accountSet = yield* scopedSubscriptionAccountSet(fakeProvider({ refreshes: 0 }), {
            source: { kind: "directory", path: directory },
            probeIntervalMs: 60_000
          });
          assert.equal(accountSet.size, 1);
          assert.equal(accountSet.mode, "codex");
          const snapshot = accountSet.snapshot();
          assert.equal(snapshot.members.length, 1);
          return accountSet;
        })
      )
    );
    await runRouteKitEffect(closed.close());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opening an account set as an Effect discovers models", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-account-set-open-"));
  try {
    writeMember(directory, "work", { accessToken: "token-work" });
    const accountSet = await runRouteKitEffect(
      openSubscriptionAccountSet(fakeProvider({ refreshes: 0 }), {
        source: { kind: "directory", path: directory },
        probeIntervalMs: 60_000
      })
    );
    try {
      const models = await runRouteKitEffect(accountSet.discoverModels());
      assert.ok(models.includes("gpt-5.3-codex"));
    } finally {
      await runRouteKitEffect(accountSet.close());
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("composite request leases release extras before the activity attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-request-lease-"));
  try {
    const coordinator = await runRouteKitEffect(
      AccountActivityCoordinator.open({
        statePath: join(directory, "account-activity.v1.json"),
        persistDebounceMs: 0,
        now: () => 1_700_000_000_000
      })
    );
    const order: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scopedRequestLease({
            activity: coordinator,
            identity: "codex:work",
            extras: [
              () => {
                order.push("stream");
              }
            ]
          });
          const snapshot = coordinator.snapshot("codex:work");
          assert.equal(snapshot.inFlight, 1);
          order.push("work");
        })
      )
    );
    assert.deepEqual(order, ["work", "stream"]);
    const after = coordinator.snapshot("codex:work");
    assert.equal(after.inFlight, 0);
    await runRouteKitEffect(coordinator.close());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stream lease release runs exactly once on interrupt", async () => {
  let releases = 0;
  const body = new ReadableStream<Uint8Array>({
    start() {
      /* held open until cancelled */
    }
  });
  const fiber = await Effect.runPromise(
    Effect.forkChild(
      readBoundedSubscriptionBodyEffect(body, () => {
        releases += 1;
      }),
      { startImmediately: true }
    )
  );
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(releases, 1);
});

test("provider discovery loads credentials and models through Effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-provider-"));
  try {
    writeMember(directory, "work", { accessToken: "token-work" });
    const provider = fakeProvider({ refreshes: 0 });
    const credential = await runRouteKitEffect(
      provider.loadCredential(join(directory, "work.json"))
    );
    const models = await runRouteKitEffect(provider.discoverModels(credential));
    assert.deepEqual(
      models.map((model) => model.id),
      ["gpt-5.3-codex"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AccountActivity service yields the coordinator from a Layer", async () => {
  const coordinator = await runRouteKitEffect(AccountActivityCoordinator.open());
  try {
    const snapshot = await runRouteKitEffect(
      Effect.gen(function* () {
        const activity = yield* AccountActivity;
        return activity.snapshot("codex:work");
      }).pipe(Effect.provide(Layer.succeed(AccountActivity, coordinator)))
    );
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.serving, false);
  } finally {
    await runRouteKitEffect(coordinator.close());
  }
});
