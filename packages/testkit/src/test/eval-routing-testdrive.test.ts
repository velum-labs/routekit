import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeWebRequest, runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem, Layer } from "effect";

import {
  DEFAULT_TESTDRIVE_FAILSAFES,
  TestdriveGuardError,
  TestdriveProcessError
} from "../eval-routing-testdrive/contracts.js";
import {
  makeTestdriveEgressGuardLoopbackTestLayer,
  TestdriveEgressGuard
} from "../eval-routing-testdrive/egress-guard.js";
import {
  makeTestdriveEvidenceLayer,
  TestdriveEvidence
} from "../eval-routing-testdrive/evidence.js";
import { makeTestdriveLedgerLayer, TestdriveLedger } from "../eval-routing-testdrive/ledger.js";
import { formatEstimatedUsd } from "../eval-routing-testdrive/main.js";
import {
  estimateTestdriveCostUsd,
  resolveTestdrivePricing,
  selectTestdriveModels,
  unpricedTestdrivePricing
} from "../eval-routing-testdrive/pricing.js";
import { TestdriveProcess, TestdriveProcessLive } from "../eval-routing-testdrive/process.js";
import {
  strictJsonSchemaResponseFormat,
  TESTDRIVE_AUTHORING_REASONING_EFFORT
} from "../eval-routing-testdrive/structured-output.js";
import { readSelectedProfileSources } from "../eval-routing-testdrive/suite-author.js";
import {
  requestWithUsage,
  reservationFromRequest,
  responseWithEstimatedCost,
  usageFromResponseText
} from "../eval-routing-testdrive/usage.js";

test("live testdrive uses strict JSON Schema authoring responses", () => {
  assert.equal(TESTDRIVE_AUTHORING_REASONING_EFFORT, "none");
  assert.deepEqual(strictJsonSchemaResponseFormat("result", { type: "object" }), {
    type: "json_schema",
    json_schema: {
      name: "result",
      schema: { type: "object" },
      strict: true
    }
  });
});

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
  assert.equal(snapshot.estimatedCostUsdStatus, "known-priced-subtotal");
  assert.equal(snapshot.dollarFailsafeStatus, "unavailable-for-unpriced-calls");
  assert.equal(formatEstimatedUsd(snapshot), "unknown");
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
            type: "cleanup-finished",
            phase: "test-resource",
            status: "passed"
          });
          yield* evidence.writeReport({
            startedAt: "2026-08-16T00:00:00.000Z",
            status: "passed",
            models: ["openai/model", "openai/model"],
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
  assert.match(result.events, /"phase":"test-resource"/u);
  assert.match(result.report, /"status": "passed"/u);
  assert.match(result.report, /"eventCount": 1/u);
  const report = JSON.parse(result.report) as {
    cleanup: readonly { phase: string; status: string }[];
    models: string[];
  };
  assert.equal(report.models.length, 1);
  assert.deepEqual(report.cleanup, [{ phase: "test-resource", status: "passed" }]);
  assert.doesNotMatch(
    `${result.events}${result.report}`,
    /authorization|credential|prompt|response/iu
  );
});

test("failed testdrive reports retain completed progress after cleanup", async () => {
  const result = await runRouteKitEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "routekit-eval-routing-failed-evidence-"
        });
        const ledgerLayer = makeTestdriveLedgerLayer(DEFAULT_TESTDRIVE_FAILSAFES);
        const evidenceLayer = makeTestdriveEvidenceLayer({
          artifactDirectory: directory,
          failsafes: DEFAULT_TESTDRIVE_FAILSAFES,
          revision: "b".repeat(40),
          runId: "run-failed"
        }).pipe(Layer.provide(ledgerLayer));
        return yield* Effect.gen(function* () {
          const evidence = yield* TestdriveEvidence;
          yield* evidence.emit({
            type: "cleanup-finished",
            phase: "embedded-router",
            status: "passed"
          });
          yield* evidence.emit({
            type: "failure",
            phase: "testdrive",
            status: "failed",
            failureCode: "interrupted"
          });
          const report = yield* evidence.writeReport({
            startedAt: "2026-08-17T00:00:00.000Z",
            status: "failed",
            models: ["openai/luna", "openai/luna"],
            profiles: [
              {
                profileId: "support",
                description: "Support requests",
                selectedModel: "openai/terra",
                fallbackModels: ["openai/luna"],
                suiteDigest: "suite",
                evidenceDigest: "evidence"
              }
            ],
            routingDecisions: [
              {
                promptKind: "support",
                profileId: "support",
                selectedModel: "openai/terra",
                evidenceDigest: "evidence",
                scores: [
                  { profileId: "support", probability: 0.75 },
                  { profileId: "coding", probability: 0.25 }
                ],
                classifierCallId: "classifier-call",
                inferenceCallId: "inference-call"
              }
            ]
          });
          return {
            events: yield* evidence.events,
            report
          };
        }).pipe(Effect.provide(Layer.merge(ledgerLayer, evidenceLayer)));
      })
    )
  );
  assert.deepEqual(
    result.events.map(({ type }) => type),
    ["cleanup-finished", "failure"]
  );
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.eventCount, 2);
  assert.equal(result.report.models.length, 1);
  assert.equal(result.report.profiles.length, 1);
  assert.equal(result.report.routingDecisions.length, 1);
  assert.deepEqual(result.report.cleanup, [{ phase: "embedded-router", status: "passed" }]);
});

const selectedSources = (
  repositoryRoot: string,
  selectedFiles: readonly string[],
  sourceInventory: readonly string[]
) =>
  runRouteKitEffect(
    readSelectedProfileSources({
      repositoryRoot,
      selectedFiles,
      sourceInventory
    })
  );

test("suite author reads a valid regular source from the bounded inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-source-valid-"));
  await writeFile(path.join(root, "source.md"), "valid source\n");
  const sources = await selectedSources(root, ["source.md"], ["source.md"]);
  assert.deepEqual(sources, [{ path: "source.md", content: "valid source\n" }]);
});

test("suite author rejects parent traversal even when selected", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "routekit-source-traversal-"));
  const root = path.join(parent, "checkout");
  await mkdir(root);
  await writeFile(path.join(parent, "outside.md"), "outside\n");
  await assert.rejects(
    selectedSources(root, ["../outside.md"], ["../outside.md"]),
    (error: unknown) =>
      error instanceof Error &&
      "detail" in error &&
      String(error.detail).includes("not a canonical relative path")
  );
});

test("suite author rejects an absolute selected path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-source-absolute-"));
  const outside = path.join(os.tmpdir(), `routekit-source-${String(process.pid)}.md`);
  await writeFile(outside, "outside\n");
  await assert.rejects(
    selectedSources(root, [outside], [outside]),
    (error: unknown) =>
      error instanceof Error &&
      "detail" in error &&
      String(error.detail).includes("not a canonical relative path")
  );
});

test("suite author rejects a symlink to an external source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-source-symlink-"));
  const outside = path.join(os.tmpdir(), `routekit-external-${String(process.pid)}.md`);
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(root, "source.md"));
  await assert.rejects(
    selectedSources(root, ["source.md"], ["source.md"]),
    (error: unknown) =>
      error instanceof Error &&
      "detail" in error &&
      String(error.detail).includes("regular non-symlink file")
  );
});

test("suite author rejects a selected source absent from the inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-source-inventory-"));
  await writeFile(path.join(root, "source.md"), "valid source\n");
  await assert.rejects(
    selectedSources(root, ["source.md"], []),
    (error: unknown) =>
      error instanceof Error &&
      "detail" in error &&
      String(error.detail).includes("not in the bounded inventory")
  );
});

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      resolve(address.port);
    });
  });

const close = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );

for (const status of [307, 308] as const) {
  test(`egress guard rejects ${String(status)} without forwarding credentials or body`, async () => {
    let redirectedRequests = 0;
    const target = createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const targetPort = await listen(target);
    const redirect = createServer((_request, response) => {
      response.writeHead(status, {
        location: `http://127.0.0.1:${String(targetPort)}/captured`
      });
      response.end();
    });
    const redirectPort = await listen(redirect);
    try {
      const snapshot = await runRouteKitEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "routekit-egress-redirect-"
            });
            const ledgerLayer = makeTestdriveLedgerLayer(DEFAULT_TESTDRIVE_FAILSAFES);
            const evidenceLayer = makeTestdriveEvidenceLayer({
              artifactDirectory: directory,
              failsafes: DEFAULT_TESTDRIVE_FAILSAFES,
              revision: "a".repeat(40),
              runId: `redirect-${String(status)}`
            }).pipe(Layer.provide(ledgerLayer));
            const stateLayer = Layer.merge(ledgerLayer, evidenceLayer);
            const guardLayer = makeTestdriveEgressGuardLoopbackTestLayer({
              upstreamOrigin: `http://127.0.0.1:${String(redirectPort)}`,
              upstreamBearerCredential: "upstream-secret",
              inboundBearerCredential: "local-secret",
              failsafes: DEFAULT_TESTDRIVE_FAILSAFES
            }).pipe(Layer.provide(stateLayer));
            return yield* Effect.gen(function* () {
              const guard = yield* TestdriveEgressGuard;
              const ledger = yield* TestdriveLedger;
              const response = yield* executeWebRequest(`${guard.origin}/v1/chat/completions`, {
                method: "POST",
                headers: {
                  authorization: "Bearer local-secret",
                  "content-type": "application/json"
                },
                body: JSON.stringify({
                  model: "openai/gpt-5.6-luna",
                  messages: [{ role: "user", content: "do not forward" }],
                  max_completion_tokens: 16
                })
              });
              assert.equal(response.status, 429);
              return yield* ledger.snapshot;
            }).pipe(Effect.provide(Layer.merge(stateLayer, guardLayer)));
          })
        )
      );
      assert.equal(redirectedRequests, 0);
      assert.equal(snapshot.activeReservations, 0);
      assert.equal(snapshot.unknownMeasurements, 1);
    } finally {
      await Promise.all([close(redirect), close(target)]);
    }
  });
}

const processTerminated = async (pid: number): Promise<boolean> => {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    return stat.split(" ")[2] === "Z";
  } catch {
    return true;
  }
};

test("testdrive process timeout escalates and terminates the complete process group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-process-group-"));
  const pidFile = path.join(root, "pids");
  const script = [
    "trap '' TERM",
    "(trap '' TERM; while :; do sleep 1; done) &",
    'printf \"%s %s\\n\" \"$$\" \"$!\" > \"$1\"',
    "wait"
  ].join("\n");
  const started = Date.now();
  await assert.rejects(
    runRouteKitEffect(
      Effect.gen(function* () {
        const processService = yield* TestdriveProcess;
        return yield* processService.run("sh", ["-c", script, "sh", pidFile], {
          timeoutMs: 100
        });
      }).pipe(Effect.provide(TestdriveProcessLive))
    ),
    (error: unknown) =>
      error instanceof TestdriveProcessError &&
      error.detail === "process exceeded its testdrive timeout"
  );
  assert.ok(Date.now() - started < 9_000);
  const [parentPid, grandchildPid] = (await readFile(pidFile, "utf8"))
    .trim()
    .split(/\s+/u)
    .map(Number);
  assert.ok(parentPid !== undefined && grandchildPid !== undefined);
  assert.equal(await processTerminated(parentPid), true);
  assert.equal(await processTerminated(grandchildPid), true);
});
