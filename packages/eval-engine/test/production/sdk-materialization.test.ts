import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ROUTEKIT_EVAL_RESULTS_FILE_ENV } from "../../src/vendor/framework/cli/src/commands/eval/results.ts";
import {
  applyEvalSdkEnv,
  materializeEvalSdk,
  ROUTEKIT_EVAL_COMPARISON_ID_ENV,
  ROUTEKIT_EVAL_RUNTIME_ORIGIN_ENV
} from "../../src/vendor/framework/cli/src/commands/eval/sdk-injection.ts";

const execFileAsync = promisify(execFile);

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not report an address"));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

test("materializes only the RouteKit Eval author SDK export", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-sdk-test-"));
  const nodeModules = path.join(root, "node_modules");
  await mkdir(nodeModules, { recursive: true });

  const materialized = await Effect.runPromise(
    materializeEvalSdk(root, { directory: nodeModules }).pipe(Effect.provide(NodeServicesLayer))
  );
  assert.deepEqual(materialized, { kind: "borrowed" });

  const packageRoot = path.join(nodeModules, "routekit");
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8")
  ) as { readonly name: string; readonly exports: Record<string, string> };
  assert.equal(packageJson.name, "routekit");
  assert.deepEqual(packageJson.exports, { "./eval": "./eval.js" });
  const sdkSource = await readFile(path.join(packageRoot, "eval.js"), "utf8");
  assert.doesNotMatch(
    sdkSource,
    /\bOri\b|@ori|["']ori\/|ORI_[A-Z0-9_]+|__ori_[a-z0-9_]+|Symbol\.for\(["']ori\//u
  );
  assert.deepEqual(
    (await import(path.join(packageRoot, "eval.js"))).setupAgent instanceof Function,
    true
  );

  const childEnv = applyEvalSdkEnv(
    { NODE_PATH: "/existing", NODE_TEST_CONTEXT: "child-v8" },
    { kind: "owned", directory: "/generated" },
    ":"
  );
  assert.equal(childEnv.NODE_TEST_CONTEXT, undefined);
  assert.equal(childEnv.NODE_PATH, "/generated:/existing");
});

test("generated routekit/eval sends attributed candidate and judge requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-sdk-run-"));
  const nodeModules = path.join(root, "node_modules");
  const resultsPath = path.join(root, "results.jsonl");
  const requests: Array<Record<string, unknown>> = [];
  await mkdir(nodeModules, { recursive: true });
  await Effect.runPromise(
    materializeEvalSdk(root, { directory: nodeModules }).pipe(Effect.provide(NodeServicesLayer))
  );

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      const role = body.role;
      const text =
        role === "judge"
          ? JSON.stringify({ pass: true, score: 0.9, reason: "helpful" })
          : "Helpful answer";
      const events = [
        {
          type: "runtime.event",
          event: {
            type: "assistant.text.delta",
            payload: { delta: text }
          }
        },
        ...(role === "judge"
          ? [
              {
                type: "runtime.event",
                event: {
                  type: "item.completed",
                  payload: {
                    data: { pass: true, score: 0.9, reason: "helpful" }
                  }
                }
              }
            ]
          : []),
        {
          type: "runtime.event",
          event: {
            type: "turn.succeeded",
            model: body.model,
            harness: "routekit",
            payload: { usage: { inputTokens: 3, outputTokens: 2 } }
          }
        },
        {
          type: "runtime.event",
          event: {
            type: "session.succeeded",
            model: body.model,
            harness: "routekit",
            payload: { usage: { inputTokens: 3, outputTokens: 2 } }
          }
        }
      ];
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    });
  });
  const port = await listen(server);

  const runner = path.join(root, "run.mjs");
  await writeFile(
    runner,
    [
      'import { setupAgent, setupJudge } from "routekit/eval";',
      'const candidate = setupAgent({ model: "openai/candidate" });',
      'const run = await candidate.run("Help me");',
      "run.toComplete();",
      'const judge = setupJudge({ agent: setupAgent({ model: "openai/judge" }), minScore: 0.8 });',
      'await judge.autoEvals({ criteria: "Helpful", prompt: "Help me", run });'
    ].join("\n")
  );

  try {
    await execFileAsync(process.execPath, [runner], {
      cwd: root,
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        [ROUTEKIT_EVAL_RUNTIME_ORIGIN_ENV]: `http://127.0.0.1:${String(port)}/`,
        [ROUTEKIT_EVAL_RESULTS_FILE_ENV]: resultsPath,
        [ROUTEKIT_EVAL_COMPARISON_ID_ENV]: "comparison-1"
      }
    });
  } finally {
    await close(server);
  }

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ role, model, comparisonId, telemetrySurface }) => ({
      role,
      model,
      comparisonId,
      telemetrySurface
    })),
    [
      {
        role: "candidate",
        model: "openai/candidate",
        comparisonId: "comparison-1",
        telemetrySurface: "routekit.eval"
      },
      {
        role: "judge",
        model: "openai/judge",
        comparisonId: "comparison-1",
        telemetrySurface: "routekit.eval"
      }
    ]
  );
  assert.equal(
    requests.every(({ runKey }) => typeof runKey === "string"),
    true
  );

  const lines = (await readFile(resultsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    lines.some((line) => line.role === "candidate"),
    true
  );
  assert.equal(
    lines.some((line) => line.role === "judge"),
    true
  );
  assert.equal(
    lines.some((line) => line.score === 0.9),
    true
  );
});
