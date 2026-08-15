import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Exit } from "effect";

import type { EvalComparisonRequest } from "@velum-labs/routekit-eval-contracts";

import {
  EvalEngine,
  EvalEngineInvalidRequestError,
  EvalEnginePortableImportError,
  makeEvalEngineLayer
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

test("Effect-native seam discovers and validates the real vendored eval format", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-library-"));
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(
    path.join(root, "nested", "support.eval.ts"),
    'import { test } from "node:test";\ntest("case", () => {});\n'
  );
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", "ignored", "hidden.eval.ts"),
    ""
  );

  const program = Effect.gen(function* () {
    const engine = yield* EvalEngine;
    const discovery = yield* engine.discover(root);
    const validation = yield* engine.validate(root);
    return { discovery, validation };
  }).pipe(
    Effect.provide(
      makeEvalEngineLayer({
        execute: () =>
          Effect.die(new Error("execution should not run during discovery"))
      })
    ),
    Effect.provide(NodeServicesLayer)
  );
  const { discovery, validation } = await Effect.runPromise(program);
  assert.equal(discovery.files.length, 1);
  assert.match(discovery.files[0] ?? "", /support\.eval\.ts$/u);
  assert.match(validation.suiteDigest, /^[a-f0-9]{64}$/u);
});

test("validation rejects non-portable imports before the execution port runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-import-"));
  await writeFile(
    path.join(root, "bad.eval.ts"),
    'import "/machine/only/module.ts";\n'
  );
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
            return Effect.succeed({ results: [], tests: [] });
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
            Effect.succeed({
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
            return Effect.succeed({ results: [], tests: [] });
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
