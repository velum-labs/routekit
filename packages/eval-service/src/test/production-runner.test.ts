import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { EvalComparisonRequest } from "@velum-labs/routekit-eval-contracts";
import { Effect, Exit } from "effect";

import {
  EvalComparisonRunnerCredentialError,
  makeEvalComparisonRunner
} from "../production-runner.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const requestFor = (suitePath: string, gatewayUrl = "http://127.0.0.1:8080") =>
  ({
    version: 1,
    profileId: "support",
    suitePath,
    candidateModels: ["openai/cheap", "anthropic/strong"],
    judgeModel: "openai/judge",
    gatewayUrl
  }) satisfies EvalComparisonRequest;

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

test("production runner validates and estimates authored cases without a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-estimate-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(
    suite,
    [
      'import { test } from "node:test";',
      'import { setupAgent, setupJudge } from "routekit/eval";',
      "const cases = [",
      '  { id: "one", prompt: "one, with comma" },',
      '  { id: "two", prompt: "two", nested: { values: [1, 2] } },',
      '  { id: "three", prompt: `three` },',
      "] as const;",
      "for (const testCase of cases) {",
      '  test(testCase.id, async () => { throw new Error("must not execute"); });',
      "}"
    ].join("\n")
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* makeEvalComparisonRunner({});
      yield* runner.validate(suite);
      return yield* runner.estimate(requestFor(suite), "pilot");
    }).pipe(Effect.provide(NodeHttpClient.layerUndici))
  );

  // Three logical cases × two candidates, with one candidate and one judge
  // call for each candidate/case pairing.
  assert.deepEqual(result, { callCount: 12, pricingKnown: false });
  assert.equal("maximumCostUsd" in result, false);
});

test("production runner fails paid execution clearly when no credential was injected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-token-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(suite, 'import { test } from "node:test"; test("case", () => {});\n');

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* makeEvalComparisonRunner({});
      return yield* runner.runComparison(requestFor(suite), "pilot");
    }).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /requires an injected bearer credential/u);
    assert.match(String(exit.cause), new RegExp(EvalComparisonRunnerCredentialError.name));
  }
});

test("production runner executes candidate and judge traffic through the live engine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-live-"));
  roots.push(root);
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
    readonly model: unknown;
  }> = [];
  const gateway = createServer((incoming, outgoing) => {
    void (async () => {
      const body = JSON.parse(await readBody(incoming)) as Readonly<Record<string, unknown>>;
      calls.push({ authorization: incoming.headers.authorization, model: body.model });
      const content =
        body.model === "openai/judge"
          ? JSON.stringify({ pass: true, reason: "helpful", score: 0.9 })
          : "Helpful answer";
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: "assistant", content } }]
        })
      );
    })();
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* makeEvalComparisonRunner({
          bearerCredential: "parent-only-token"
        });
        return yield* runner.runComparison(
          {
            ...requestFor(suite, `http://127.0.0.1:${String(address.port)}`),
            candidateModels: ["openai/cheap"]
          },
          "pilot"
        );
      }).pipe(Effect.provide(NodeHttpClient.layerUndici))
    );

    assert.deepEqual(
      calls.map(({ model }) => model),
      ["openai/cheap", "openai/judge"]
    );
    assert.equal(
      calls.every(({ authorization }) => authorization === "Bearer parent-only-token"),
      true
    );
    assert.deepEqual(
      result.models.map(({ model }) => model),
      ["openai/cheap"]
    );
    assert.equal(JSON.stringify(result).includes("parent-only-token"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});
