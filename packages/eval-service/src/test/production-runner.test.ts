import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { EvalComparisonRequest } from "@velum-labs/routekit-eval-contracts";
import { Effect, Exit } from "effect";

import {
  EvalComparisonRunnerCredentialError,
  EvalComparisonRunnerManifestError,
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

const writeManifest = async (
  root: string,
  candidateModels: readonly string[],
  judgeModel: string,
  caseIds: readonly string[]
): Promise<void> => {
  await writeFile(
    path.join(root, "routekit.eval-manifest.json"),
    `${JSON.stringify({
      version: 1,
      profileId: "support",
      candidateModels,
      judgeModel,
      caseCount: caseIds.length,
      caseIds,
      maxOutputTokens: 1_024,
      expectedCallCount: caseIds.length * candidateModels.length * 2
    })}\n`
  );
};

test("production runner estimates the exact imported nested-loop testdrive suite from its manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-estimate-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  const candidates = ["openai/luna", "openai/terra", "openai/sol"];
  const caseIds = ["one", "two", "three", "four", "five"];
  await mkdir(path.join(root, "data"));
  await writeFile(
    path.join(root, "data", "cases.json"),
    `${JSON.stringify(caseIds.map((id) => ({ id, prompt: id })))}\n`
  );
  await writeManifest(root, candidates, "openai/terra", caseIds);
  await writeFile(
    suite,
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { setupAgent, setupJudge } from "routekit/eval";',
      'import cases from "./data/cases.json" with { type: "json" };',
      'import manifest from "./routekit.eval-manifest.json" with { type: "json" };',
      "const candidateModels = manifest.candidateModels;",
      "assert.equal(cases.length, manifest.caseCount);",
      "const judge = setupJudge({ agent: setupAgent({ model: manifest.judgeModel }) });",
      "for (const model of candidateModels) {",
      "  const candidate = setupAgent({ model });",
      "  for (const testCase of cases) {",
      "    test(`${model} / ${testCase.id}`, async () => {",
      "      const run = await candidate.run({ prompt: testCase.prompt, caseId: testCase.id });",
      "      run.toComplete();",
      '      await judge.autoEvals({ criteria: "correct", prompt: testCase.prompt, run });',
      "    });",
      "  }",
      "}"
    ].join("\n")
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* makeEvalComparisonRunner({});
      yield* runner.validate(suite);
      return yield* runner.estimate(
        {
          ...requestFor(suite),
          candidateModels: candidates,
          judgeModel: "openai/terra"
        },
        "pilot"
      );
    }).pipe(Effect.provide(NodeHttpClient.layerUndici))
  );

  assert.deepEqual(result, { callCount: 30, pricingKnown: false });
  assert.equal("maximumCostUsd" in result, false);
});

test("production runner rejects a manifest for a different profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-profile-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(suite, 'import { test } from "node:test"; test("case", () => {});\n');
  await writeManifest(root, ["openai/cheap", "anthropic/strong"], "openai/judge", ["case"]);
  const manifestPath = path.join(root, "routekit.eval-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, profileId: "different-profile" })}\n`
  );

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* makeEvalComparisonRunner({});
      return yield* runner.estimate(requestFor(suite), "pilot");
    }).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /profile or models do not match/u);
    assert.match(String(exit.cause), new RegExp(EvalComparisonRunnerManifestError.name));
  }
});

test("production runner fails paid execution clearly when no credential was injected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-token-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(suite, 'import { test } from "node:test"; test("case", () => {});\n');
  await writeManifest(root, ["openai/cheap", "anthropic/strong"], "openai/judge", ["case"]);

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
      '  const run = await setupAgent({ model: "openai/cheap" }).run({ prompt: "Help", caseId: "support-case" });',
      "  run.toComplete();",
      '  await judge.autoEvals({ criteria: "Helpful", prompt: "Help", run });',
      "});"
    ].join("\n")
  );
  await writeManifest(root, ["openai/cheap"], "openai/judge", ["support-case"]);

  const calls: Array<{
    readonly authorization: string | undefined;
    readonly maxOutputTokens: unknown;
    readonly model: unknown;
  }> = [];
  const gateway = createServer((incoming, outgoing) => {
    void (async () => {
      const body = JSON.parse(await readBody(incoming)) as Readonly<Record<string, unknown>>;
      calls.push({
        authorization: incoming.headers.authorization,
        maxOutputTokens: body.max_completion_tokens,
        model: body.model
      });
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
    assert.equal(
      calls.every(({ maxOutputTokens }) => maxOutputTokens === 1_024),
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
