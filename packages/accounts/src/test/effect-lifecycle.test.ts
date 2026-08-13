import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect, Fiber } from "effect";

import { EffectAccountActivityCoordinator } from "../effect-api.js";
import {
  EffectSubscriptionProvider,
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
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const accountSet = yield* scopedSubscriptionAccountSet(fakeProvider({ refreshes: 0 }), {
            source: { kind: "directory", path: directory },
            probeIntervalMs: 60_000
          });
          assert.equal(accountSet.size, 1);
          assert.equal(accountSet.mode, "codex");
          const snapshot = yield* accountSet.snapshot();
          assert.equal(snapshot.members.length, 1);
          return accountSet.inner;
        })
      )
    );
    await closed.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opening an account set as an Effect still exposes the Promise façade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-account-set-open-"));
  try {
    writeMember(directory, "work", { accessToken: "token-work" });
    const accountSet = await Effect.runPromise(
      openSubscriptionAccountSet(fakeProvider({ refreshes: 0 }), {
        source: { kind: "directory", path: directory },
        probeIntervalMs: 60_000
      })
    );
    try {
      const models = await Effect.runPromise(accountSet.discoverModels());
      assert.ok(models.includes("gpt-5.3-codex"));
    } finally {
      await Effect.runPromise(accountSet.close());
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("composite request leases release extras before the activity attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-request-lease-"));
  try {
    const coordinator = new EffectAccountActivityCoordinator({
      statePath: join(directory, "account-activity.v1.json"),
      persistDebounceMs: 0,
      now: () => 1_700_000_000_000
    });
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
          const snapshot = yield* coordinator.snapshot("codex:work");
          assert.equal(snapshot.inFlight, 1);
          order.push("work");
        })
      )
    );
    assert.deepEqual(order, ["work", "stream"]);
    const after = await Effect.runPromise(coordinator.snapshot("codex:work"));
    assert.equal(after.inFlight, 0);
    await Effect.runPromise(coordinator.close());
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
      readBoundedSubscriptionBodyEffect(
        body,
        () => {
          releases += 1;
        }
      ),
      { startImmediately: true }
    )
  );
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(releases, 1);
});

test("provider discovery adapters wrap existing credential lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-effect-provider-"));
  try {
    writeMember(directory, "work", { accessToken: "token-work" });
    const provider = new EffectSubscriptionProvider(fakeProvider({ refreshes: 0 }));
    const credential = await Effect.runPromise(
      provider.loadCredential(join(directory, "work.json"))
    );
    const models = await Effect.runPromise(provider.discoverModels(credential));
    assert.deepEqual(
      models.map((model) => model.id),
      ["gpt-5.3-codex"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
