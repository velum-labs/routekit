import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import type { EvalComparisonRequest } from "@velum-labs/routekit-eval-contracts";
import { Effect, Exit, Stream } from "effect";

import {
  evalExecutionModels,
  EvalEngine,
  EvalEngineDryLoadError,
  EvalEngineInvalidRequestError,
  EvalEnginePortableImportError,
  makeEvalEngineLayer,
  makeRouteKitEvalExecutionPort,
  normalizeEvalComparisonEvidence
} from "../../src/index.ts";
import { joinOutcomes } from "../../src/vendor/framework/cli/src/commands/eval/results-lines.ts";

const request = (suitePath: string): EvalComparisonRequest => ({
  version: 1,
  profileId: "support",
  suitePath,
  candidateModels: ["openai/cheap", "anthropic/strong"],
  judgeModel: "openai/judge",
  gatewayUrl: "http://127.0.0.1:8080"
});

const readBody = async (incoming: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );

test("Effect-native seam discovers and validates the real vendored eval format", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-library-"));
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(
    path.join(root, "nested", "support.eval.ts"),
    'import { test } from "node:test";\ntest("case", () => {});\n'
  );
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "ignored", "hidden.eval.ts"), "");

  const program = Effect.gen(function* () {
    const engine = yield* EvalEngine;
    const discovery = yield* engine.discover(root);
    const validation = yield* engine.validate(root);
    return { discovery, validation };
  }).pipe(
    Effect.provide(
      makeEvalEngineLayer({
        execute: () => Stream.die(new Error("execution should not run during discovery"))
      })
    ),
    Effect.provide(NodeServicesLayer)
  );
  const { discovery, validation } = await Effect.runPromise(program);
  assert.equal(discovery.files.length, 1);
  assert.match(discovery.files[0] ?? "", /support\.eval\.ts$/u);
  assert.match(validation.suiteDigest, /^[a-f0-9]{64}$/u);
});

test("validation dry-loads top level while never executing test bodies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-dry-load-"));
  const topLevelMarker = path.join(root, "top-level.txt");
  const bodyMarker = path.join(root, "body.txt");
  await writeFile(
    path.join(root, "support.eval.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { test } from "node:test";',
      `writeFileSync(${JSON.stringify(topLevelMarker)}, "loaded");`,
      'import { setupAgent } from "routekit/eval";',
      'test("must not execute", async () => {',
      `  writeFileSync(${JSON.stringify(bodyMarker)}, "executed");`,
      '  await setupAgent({ model: "openai/never-call" }).run("must not infer");',
      "});"
    ].join("\n")
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return yield* engine.validate(root);
    }).pipe(
      Effect.provide(
        makeEvalEngineLayer({
          execute: () => Stream.die(new Error("execution port must not run"))
        })
      ),
      Effect.provide(NodeServicesLayer)
    )
  );

  assert.equal(await readFile(topLevelMarker, "utf8"), "loaded");
  await assert.rejects(readFile(bodyMarker, "utf8"), { code: "ENOENT" });
});

test("validation reports a typed dry-load failure for top-level errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-dry-fail-"));
  await writeFile(
    path.join(root, "broken.eval.ts"),
    [
      'import { test } from "node:test";',
      'throw new Error("top-level initialization failed");',
      'test("unreachable", () => {});'
    ].join("\n")
  );
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return yield* engine.validate(root);
    }).pipe(
      Effect.provide(
        makeEvalEngineLayer({
          execute: () => Stream.die(new Error("execution port must not run"))
        })
      ),
      Effect.provide(NodeServicesLayer),
      Effect.exit
    )
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), new RegExp(EvalEngineDryLoadError.name));
  }
});

test("validation rejects non-portable imports before the execution port runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-import-"));
  await writeFile(path.join(root, "bad.eval.ts"), 'import "/machine/only/module.ts";\n');
  let executed = false;
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return yield* engine.runComparison(request(root));
    }).pipe(
      Effect.provide(
        makeEvalEngineLayer({
          execute: () => {
            executed = true;
            return Stream.succeed({ results: [], tests: [] });
          }
        })
      ),
      Effect.provide(NodeServicesLayer),
      Effect.exit
    )
  );
  assert.equal(Exit.isFailure(exit), true);
  assert.equal(executed, false);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), new RegExp(EvalEnginePortableImportError.name));
  }
});

test("comparison normalization consumes vendored crash-tolerant JSONL semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-run-"));
  const suite = path.join(root, "support.eval.ts");
  await writeFile(suite, 'import { test } from "node:test";\n');
  const results = joinOutcomes([
    {
      requestedModel: "openai/cheap",
      role: "candidate",
      runKey: "cheap-1"
    },
    {
      model: "openai/cheap",
      role: "candidate",
      runKey: "cheap-1",
      durationMs: 42,
      terminal: {
        model: "openai/cheap",
        type: "turn.succeeded",
        payload: {
          usage: {
            costUsd: 0.001,
            inputTokens: 10,
            outputTokens: 5
          }
        }
      }
    },
    {
      outcome: "passed",
      runKey: "cheap-1",
      score: 0.8
    },
    {
      requestedModel: "anthropic/strong",
      role: "candidate",
      runKey: "strong-cutoff"
    },
    {
      model: "openai/judge",
      role: "judge",
      runKey: "judge-1"
    }
  ]);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return yield* engine.runComparison(request(root));
    }).pipe(
      Effect.provide(
        makeEvalEngineLayer({
          execute: () =>
            Stream.succeed({
              results,
              tests: [
                { name: "cheap case", status: "pass" },
                { name: "strong case", status: "fail" }
              ]
            })
        })
      ),
      Effect.provide(NodeServicesLayer)
    )
  );
  assert.deepEqual(evalExecutionModels({ results, tests: [] }), {
    candidateModels: ["openai/cheap", "anthropic/strong"],
    judgeModels: ["openai/judge"]
  });
  const normalized = await Effect.runPromise(
    normalizeEvalComparisonEvidence({
      comparisonId: "persisted-comparison",
      request: request(root),
      output: {
        results,
        tests: [
          { name: "cheap case", status: "pass" },
          { name: "strong case", status: "fail" }
        ]
      },
      suiteDigest: "persisted-suite-digest",
      startedAt: "2026-08-16T00:00:00.000Z",
      finishedAt: "2026-08-16T00:01:00.000Z"
    })
  );
  assert.deepEqual(normalized.models, result.models);
  assert.equal(normalized.comparisonId, "persisted-comparison");
  assert.deepEqual(result.models, [
    {
      model: "openai/cheap",
      cases: [
        {
          caseId: "cheap case",
          outcome: "passed",
          measurement: {
            costUsd: 0.001,
            durationMs: 42,
            judgeScore: 0.8,
            inputTokens: 10,
            outputTokens: 5
          }
        }
      ]
    },
    {
      model: "anthropic/strong",
      cases: [
        {
          caseId: "strong case",
          outcome: "cutoff",
          measurement: {}
        }
      ]
    }
  ]);
});

test("comparison fails when a requested candidate produced no cases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-missing-"));
  await writeFile(path.join(root, "support.eval.ts"), "");
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return yield* engine.runComparison(request(root));
    }).pipe(
      Effect.provide(
        makeEvalEngineLayer({
          execute: () =>
            Stream.succeed({
              results: joinOutcomes([
                {
                  requestedModel: "openai/cheap",
                  role: "candidate",
                  runKey: "cheap-1"
                }
              ]),
              tests: [{ name: "cheap case", status: "pass" }]
            })
        })
      ),
      Effect.provide(NodeServicesLayer),
      Effect.exit
    )
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /no cases for requested candidate model/u);
    assert.match(String(exit.cause), /anthropic\/strong/u);
  }
});

test("comparison rejects unrequested candidate and mismatched judge evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-extra-"));
  await writeFile(path.join(root, "support.eval.ts"), "");
  const run = async (results: ReturnType<typeof joinOutcomes>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EvalEngine;
        return yield* engine.runComparison({
          ...request(root),
          candidateModels: ["openai/cheap"]
        });
      }).pipe(
        Effect.provide(
          makeEvalEngineLayer({
            execute: () =>
              Stream.succeed({
                results,
                tests: [{ name: "case", status: "pass" }]
              })
          })
        ),
        Effect.provide(NodeServicesLayer),
        Effect.exit
      )
    );

  const candidateExit = await run(
    joinOutcomes([
      {
        model: "openai/unrequested",
        role: "candidate",
        runKey: "candidate-1"
      }
    ])
  );
  assert.equal(Exit.isFailure(candidateExit), true);
  if (Exit.isFailure(candidateExit)) {
    assert.match(String(candidateExit.cause), /unrequested candidate model/u);
    assert.match(String(candidateExit.cause), /openai\/unrequested/u);
  }

  const judgeExit = await run(
    joinOutcomes([
      {
        model: "openai/cheap",
        role: "candidate",
        runKey: "candidate-1"
      },
      {
        model: "openai/wrong-judge",
        role: "judge",
        runKey: "judge-1"
      }
    ])
  );
  assert.equal(Exit.isFailure(judgeExit), true);
  if (Exit.isFailure(judgeExit)) {
    assert.match(String(judgeExit.cause), /judge evidence/u);
    assert.match(String(judgeExit.cause), /openai\/wrong-judge/u);
  }
});

const plannedCaseIds = ["one", "two", "three", "four", "five"] as const;
const plannedCandidates = ["openai/cheap", "anthropic/strong"] as const;
const plannedDigest = "planned-suite-digest";

const plannedRequest = (): EvalComparisonRequest => ({
  ...request("/unused"),
  candidateModels: [...plannedCandidates],
  expectedCaseIds: [...plannedCaseIds],
  expectedCallCount: plannedCaseIds.length * plannedCandidates.length * 2,
  maxOutputTokens: 1_024,
  suiteDigest: plannedDigest
});

const completePlannedRows = () =>
  joinOutcomes(
    plannedCandidates.flatMap((model) =>
      plannedCaseIds.flatMap((caseId) => {
        const candidateKey = `${model}:${caseId}`;
        const judgeKey = `judge:${model}:${caseId}`;
        return [
          {
            caseId,
            requestedModel: model,
            role: "candidate" as const,
            runKey: candidateKey
          },
          {
            caseId,
            model,
            role: "candidate" as const,
            runKey: candidateKey
          },
          {
            outcome: "passed" as const,
            runKey: candidateKey,
            score: 0.9
          },
          {
            caseId,
            requestedModel: "openai/judge",
            role: "judge" as const,
            runKey: judgeKey
          },
          {
            caseId,
            model: "openai/judge",
            role: "judge" as const,
            runKey: judgeKey
          },
          {
            outcome: "passed" as const,
            runKey: judgeKey
          }
        ];
      })
    )
  );

const normalizePlanned = (results: ReturnType<typeof completePlannedRows>) =>
  Effect.runPromise(
    normalizeEvalComparisonEvidence({
      comparisonId: "comparison-planned",
      request: plannedRequest(),
      output: { results, tests: [] },
      suiteDigest: plannedDigest,
      startedAt: "2026-08-17T00:00:00.000Z",
      finishedAt: "2026-08-17T00:01:00.000Z"
    })
  );

test("authoritative comparison accepts complete five-case evidence", async () => {
  const comparison = await normalizePlanned(completePlannedRows());
  assert.deepEqual(
    comparison.models.map(({ model, cases }) => ({
      model,
      caseIds: cases.map(({ caseId }) => caseId)
    })),
    plannedCandidates.map((model) => ({ model, caseIds: [...plannedCaseIds] }))
  );
});

test("authoritative comparison rejects a missing final case", async () => {
  const rows = completePlannedRows().filter(
    (row) => !row.runKey?.includes("anthropic/strong:five")
  );
  await assert.rejects(normalizePlanned(rows), /manifest requires exactly|produced .* cases/u);
});

test("authoritative comparison rejects a duplicate case", async () => {
  const rows = completePlannedRows().map((row) =>
    row.role === "candidate" && row.model === "openai/cheap" && row.caseId === "five"
      ? { ...row, caseId: "one" }
      : row
  );
  await assert.rejects(normalizePlanned(rows), /duplicate case/u);
});

test("authoritative comparison rejects a candidate with only one result", async () => {
  const rows = completePlannedRows().filter(
    (row) => row.role !== "candidate" || row.model !== "anthropic/strong" || row.caseId === "one"
  );
  await assert.rejects(normalizePlanned(rows), /manifest requires exactly|produced .* cases/u);
});

test("authoritative comparison rejects a missing judge score", async () => {
  const rows = completePlannedRows().map((row) =>
    row.role === "candidate" && row.model === "openai/cheap" && row.caseId === "three"
      ? { ...row, score: undefined }
      : row
  );
  await assert.rejects(normalizePlanned(rows), /has no judge score/u);
});

test("authoritative comparison rejects an unexpected candidate", async () => {
  const rows = completePlannedRows().map((row) =>
    row.role === "candidate" && row.model === "openai/cheap"
      ? { ...row, model: "openai/unexpected" }
      : row
  );
  await assert.rejects(normalizePlanned(rows), /unrequested candidate model/u);
});

test("authoritative comparison rejects the wrong judge", async () => {
  const rows = completePlannedRows().map((row) =>
    row.role === "judge" ? { ...row, model: "openai/wrong-judge" } : row
  );
  await assert.rejects(normalizePlanned(rows), /judge evidence/u);
});

test("authoritative comparison rejects an unknown judge outcome", async () => {
  const rows = completePlannedRows().map((row) =>
    row.role === "judge" && row.caseId === "three" ? { ...row, outcome: "unknown" as const } : row
  );
  await assert.rejects(normalizePlanned(rows), /judge case three did not complete/u);
});

test("comparison rejects auto-router model ids without calling execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-model-"));
  await writeFile(path.join(root, "support.eval.ts"), "");
  let executed = false;
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EvalEngine;
      return yield* engine.runComparison({
        ...request(root),
        candidateModels: ["auto"]
      });
    }).pipe(
      Effect.provide(
        makeEvalEngineLayer({
          execute: () => {
            executed = true;
            return Stream.succeed({ results: [], tests: [] });
          }
        })
      ),
      Effect.provide(NodeServicesLayer),
      Effect.exit
    )
  );
  assert.equal(Exit.isFailure(exit), true);
  assert.equal(executed, false);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), new RegExp(EvalEngineInvalidRequestError.name));
  }
});

test("concrete execution runs candidate and judge calls through the injected gateway", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-concrete-"));
  const suite = path.join(root, "support.eval.ts");
  await writeFile(
    suite,
    [
      'import { test } from "node:test";',
      'import { setupAgent, setupJudge } from "routekit/eval";',
      'const judge = setupJudge({ agent: setupAgent({ model: "openai/judge" }), minScore: 0.8 });',
      'test("support case", async () => {',
      '  const run = await setupAgent({ model: "openai/cheap" }).run("Help");',
      "  run.toComplete();",
      '  await judge.autoEvals({ criteria: "Helpful", prompt: "Help", run });',
      "});"
    ].join("\n")
  );

  const calls: Array<{
    readonly authorization: string | undefined;
    readonly attribution: string | undefined;
    readonly bypass: string | undefined;
    readonly body: Readonly<Record<string, unknown>>;
  }> = [];
  const gateway = createServer((incoming, outgoing) => {
    void (async () => {
      const body = JSON.parse(await readBody(incoming)) as Readonly<Record<string, unknown>>;
      calls.push({
        authorization: incoming.headers.authorization,
        attribution: incoming.headers["x-routekit-eval-attribution"] as string | undefined,
        bypass: incoming.headers["x-routekit-eval-policy-bypass"] as string | undefined,
        body
      });
      const judge = body.model === "openai/judge";
      const content = judge
        ? JSON.stringify({ pass: true, reason: "helpful", score: 0.9 })
        : "Helpful answer";
      const response = {
        model: body.model,
        choices: [{ message: { role: "assistant", content } }],
        usage: {
          prompt_tokens: judge ? 8 : 3,
          completion_tokens: judge ? 5 : 2,
          cost_usd: judge ? 0.01 : 0.001
        }
      };
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(response));
    })().catch((cause) => {
      outgoing.writeHead(500);
      outgoing.end(String(cause));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const execution = yield* makeRouteKitEvalExecutionPort({
          bearerCredential: "parent-only-secret"
        });
        return yield* Effect.gen(function* () {
          const engine = yield* EvalEngine;
          return yield* engine.runComparison({
            ...request(root),
            candidateModels: ["openai/cheap"],
            gatewayUrl: `http://127.0.0.1:${String(address.port)}`
          });
        }).pipe(Effect.provide(makeEvalEngineLayer(execution)));
      }).pipe(Effect.provide(NodeHttpClient.layerUndici))
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.body.model),
      ["openai/cheap", "openai/judge"]
    );
    assert.equal(
      calls.every(
        (call) =>
          call.authorization === "Bearer parent-only-secret" &&
          call.bypass === "1" &&
          call.attribution !== undefined
      ),
      true
    );
    assert.deepEqual(result.models, [
      {
        model: "openai/cheap",
        cases: [
          {
            caseId: "support case",
            outcome: "passed",
            measurement: {
              costUsd: 0.001,
              durationMs: result.models[0]?.cases[0]?.measurement.durationMs,
              inputTokens: 3,
              judgeScore: 0.9,
              outputTokens: 2
            }
          }
        ]
      }
    ]);
    assert.equal(JSON.stringify(result).includes("parent-only-secret"), false);
  } finally {
    await closeServer(gateway);
  }
});
