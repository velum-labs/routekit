import assert from "node:assert/strict";
import test from "node:test";

import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Layer } from "effect";

import {
  DEFAULT_TESTDRIVE_FAILSAFES,
  TestdriveGuardError
} from "../eval-routing-testdrive/contracts.js";
import {
  makeTestdriveEvidenceLayer,
  TestdriveEvidence
} from "../eval-routing-testdrive/evidence.js";
import { makeTestdriveLedgerLayer, TestdriveLedger } from "../eval-routing-testdrive/ledger.js";
import {
  estimateTestdriveCostUsd,
  resolveTestdrivePricing,
  selectTestdriveModels,
  unpricedTestdrivePricing
} from "../eval-routing-testdrive/pricing.js";
import {
  requestWithUsage,
  reservationFromRequest,
  responseWithEstimatedCost,
  usageFromResponseText
} from "../eval-routing-testdrive/usage.js";

test("live testdrive pricing resolves aliases and selects the GPT-5.6 slate", () => {
  const pricing = resolveTestdrivePricing("openai/gpt-5.5");
  assert.ok(pricing);
  assert.equal(pricing.pricingKey, "gpt-5.5");
  assert.equal(estimateTestdriveCostUsd(pricing, 1_000_000, 100_000), 2.25);
  const selected = selectTestdriveModels([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol"
  ]);
  assert.deepEqual(selected.slates[0], [
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol"
  ]);
  assert.equal(selected.classifier, "openai/gpt-5.6-luna");
  assert.equal(selected.author, "openai/gpt-5.6-terra");
  assert.equal(selected.judge, "openai/gpt-5.6-terra");
});

test("live testdrive usage parses JSON and terminal SSE without partial measurements", () => {
  assert.deepEqual(
    usageFromResponseText(JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 30 } })),
    { inputTokens: 120, outputTokens: 30 }
  );
  assert.deepEqual(
    usageFromResponseText(
      [
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "",
        'data: {"usage":{"input_tokens":80,"output_tokens":20}}',
        "",
        "data: [DONE]"
      ].join("\n")
    ),
    { inputTokens: 80, outputTokens: 20 }
  );
  assert.deepEqual(
    usageFromResponseText(
      [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":70}}}',
        "",
        'data: {"type":"message_delta","usage":{"output_tokens":15}}'
      ].join("\n")
    ),
    { inputTokens: 70, outputTokens: 15 }
  );
  assert.equal(usageFromResponseText(JSON.stringify({ usage: { prompt_tokens: 120 } })), undefined);
});

test("live testdrive attaches its registry estimate to measured responses", () => {
  const rewritten = responseWithEstimatedCost(
    new TextEncoder().encode(
      JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 20 } })
    ),
    0.001,
    { inputTokens: 100, outputTokens: 20 }
  );
  const payload = JSON.parse(new TextDecoder().decode(rewritten)) as {
    usage: { cost_usd: number };
  };
  assert.equal(payload.usage.cost_usd, 0.001);
});

test("live testdrive request reservations require explicit priced-model inputs", () => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 256
    })
  );
  const reservation = reservationFromRequest(body, 512);
  assert.equal(reservation.model, "openai/gpt-5.5");
  assert.equal(reservation.outputTokens, 256);
  assert.ok(reservation.inputTokens >= body.byteLength);
  assert.throws(
    () =>
      reservationFromRequest(
        new TextEncoder().encode(
          JSON.stringify({ model: "openai/gpt-5.5", max_completion_tokens: 513 })
        ),
        512
      ),
    /exceeds failsafe/
  );
});

test("live testdrive requests terminal usage for streamed egress", () => {
  const body = requestWithUsage(
    new TextEncoder().encode(
      JSON.stringify({ model: "openai/gpt-5.5", stream: true, messages: [] })
    )
  );
  const payload = JSON.parse(new TextDecoder().decode(body)) as {
    stream_options: { include_usage: boolean };
  };
  assert.equal(payload.stream_options.include_usage, true);
});

test("live testdrive ledger atomically reserves and reconciles real usage", async () => {
  const pricing = resolveTestdrivePricing("openai/gpt-5.5");
  assert.ok(pricing);
  const snapshot = await runRouteKitEffect(
    Effect.gen(function* () {
      const ledger = yield* TestdriveLedger;
      const reservation = yield* ledger.reserve({
        model: "openai/gpt-5.5",
        inputTokens: 2_000,
        outputTokens: 500,
        pricing
      });
      assert.equal((yield* ledger.snapshot).activeReservations, 1);
      return yield* ledger.reconcile(reservation, { inputTokens: 200, outputTokens: 50 });
    }).pipe(Effect.provide(makeTestdriveLedgerLayer(DEFAULT_TESTDRIVE_FAILSAFES)))
  );
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.activeReservations, 0);
  assert.equal(snapshot.inputTokens, 200);
  assert.equal(snapshot.outputTokens, 50);
});

test("live testdrive ledger records unpriced calls without inventing cost", async () => {
  const snapshot = await runRouteKitEffect(
    Effect.gen(function* () {
      const ledger = yield* TestdriveLedger;
      const reservation = yield* ledger.reserve({
        model: "openai/gpt-5.6-luna",
        inputTokens: 2_000,
        outputTokens: 500,
        pricing: unpricedTestdrivePricing("openai/gpt-5.6-luna")
      });
      return yield* ledger.reconcile(reservation, { inputTokens: 200, outputTokens: 50 });
    }).pipe(Effect.provide(makeTestdriveLedgerLayer(DEFAULT_TESTDRIVE_FAILSAFES)))
  );
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.unpricedCalls, 1);
  assert.equal(snapshot.estimatedCostUsd, 0);
  assert.equal(snapshot.unknownMeasurements, 0);
});

test("live testdrive ledger stops before a second call exceeds its failsafe", async () => {
  const pricing = resolveTestdrivePricing("openai/gpt-5.5");
  assert.ok(pricing);
  await assert.rejects(
    runRouteKitEffect(
      Effect.gen(function* () {
        const ledger = yield* TestdriveLedger;
        yield* ledger.reserve({
          model: "openai/gpt-5.5",
          inputTokens: 10,
          outputTokens: 10,
          pricing
        });
        yield* ledger.reserve({
          model: "openai/gpt-5.5",
          inputTokens: 10,
          outputTokens: 10,
          pricing
        });
      }).pipe(
        Effect.provide(
          makeTestdriveLedgerLayer({ ...DEFAULT_TESTDRIVE_FAILSAFES, maxEgressCalls: 1 })
        )
      )
    ),
    (error: unknown) =>
      error instanceof TestdriveGuardError &&
      error.code === "call-limit" &&
      error.detail.includes("call failsafe")
  );
});

test("live testdrive writes schema-bounded evidence on the real filesystem", async () => {
  const result = await runRouteKitEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "routekit-eval-routing-evidence-"
        });
        const ledgerLayer = makeTestdriveLedgerLayer(DEFAULT_TESTDRIVE_FAILSAFES);
        const evidenceLayer = makeTestdriveEvidenceLayer({
          artifactDirectory: directory,
          failsafes: DEFAULT_TESTDRIVE_FAILSAFES,
          revision: "a".repeat(40),
          runId: "run-safe"
        }).pipe(Layer.provide(ledgerLayer));
        return yield* Effect.gen(function* () {
          const evidence = yield* TestdriveEvidence;
          yield* evidence.emit({
            type: "phase-started",
            phase: "preflight",
            status: "running"
          });
          yield* evidence.writeReport({
            startedAt: "2026-08-16T00:00:00.000Z",
            status: "passed",
            models: [],
            profiles: [],
            routingDecisions: []
          });
          return {
            events: yield* fs.readFileString(`${directory}/events.jsonl`),
            report: yield* fs.readFileString(`${directory}/report.json`)
          };
        }).pipe(Effect.provide(Layer.merge(ledgerLayer, evidenceLayer)));
      })
    )
  );
  assert.match(result.events, /"phase":"preflight"/u);
  assert.match(result.report, /"status": "passed"/u);
  assert.doesNotMatch(
    `${result.events}${result.report}`,
    /authorization|credential|prompt|response/iu
  );
});
