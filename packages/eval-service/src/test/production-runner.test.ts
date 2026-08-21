import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { EvalComparisonRequest } from "@velum-labs/routekit-eval-contracts";
import { Effect, Exit } from "effect";

import { EvalServiceEstimateError, EvalServiceSpendLimitError } from "../errors.js";
import {
  EvalServiceCredentialError,
  makeRouteKitEvalServiceLayer,
  type RouteKitEvalServiceOptions
} from "../production-runner.js";
import { EvalService } from "../service.js";

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

const withEvalService = <A, E>(
  options: RouteKitEvalServiceOptions,
  use: (service: EvalService["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    return yield* use(yield* EvalService);
  }).pipe(Effect.provide(makeRouteKitEvalServiceLayer({}, options)));

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

const writeShadowEvalSdk = async (root: string, hiddenTimeoutMs: number): Promise<void> => {
  for (const name of ["routekit", "ori"]) {
    const directory = path.join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({
        name,
        private: true,
        type: "module",
        exports: { "./eval": "./eval.js" }
      })}\n`
    );
    await writeFile(
      path.join(directory, "eval.js"),
      [
        "export const setupAgent = () => ({",
        "  run: async () => {",
        `    await new Promise((resolve) => setTimeout(resolve, ${String(hiddenTimeoutMs)}));`,
        '    throw new Error("project SDK hidden timeout");',
        "  }",
        "});",
        "export const setupJudge = () => ({ autoEvals: async () => {} });"
      ].join("\n")
    );
  }
};

test("production runner estimates the exact imported nested-loop testdrive suite from its manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-estimate-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  const candidates = ["openai/gpt-5.5", "openai/gpt-5.1", "openai/gpt-4.1-mini"];
  const caseIds = ["one", "two", "three", "four", "five"];
  await mkdir(path.join(root, "data"));
  await writeFile(
    path.join(root, "data", "cases.json"),
    `${JSON.stringify(caseIds.map((id) => ({ id, prompt: id })))}\n`
  );
  await writeManifest(root, candidates, "openai/gpt-5.5", caseIds);
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
    withEvalService({}, (service) =>
      Effect.gen(function* () {
        yield* service.validate(suite);
        return yield* service.estimate(
          {
            ...requestFor(suite),
            candidateModels: candidates,
            judgeModel: "openai/gpt-5.5"
          },
          "pilot"
        );
      })
    ).pipe(Effect.provide(NodeHttpClient.layerUndici))
  );

  assert.equal(result.callCount, 30);
  assert.equal(result.pricingKnown, true);
  assert.equal((result.maximumCostUsd ?? 0) > 0, true);
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
    withEvalService({}, (service) => service.estimate(requestFor(suite), "pilot")).pipe(
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.exit
    )
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /profile or models do not match/u);
    assert.match(String(exit.cause), new RegExp(EvalServiceEstimateError.name));
  }
});

test("production runner fails paid execution clearly when no credential was injected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-token-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(suite, 'import { test } from "node:test"; test("case", () => {});\n');
  await writeManifest(root, ["openai/cheap", "anthropic/strong"], "openai/judge", ["case"]);

  const exit = await Effect.runPromise(
    withEvalService({}, (service) => service.runComparison(requestFor(suite), "pilot")).pipe(
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.exit
    )
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /requires an injected bearer credential/u);
    assert.match(String(exit.cause), new RegExp(EvalServiceCredentialError.name));
  }
});

test("production runner enforces spendLimitUsd before live execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-spend-limit-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(
    suite,
    [
      'import { test } from "node:test";',
      'import { setupAgent, setupJudge } from "routekit/eval";',
      'const judge = setupJudge({ agent: setupAgent({ model: "openai/gpt-5.5" }) });',
      'test("support case", async () => {',
      '  const run = await setupAgent({ model: "openai/gpt-5.1" }).run("Help");',
      "  run.toComplete();",
      '  await judge.autoEvals({ criteria: "Helpful", prompt: "Help", run });',
      "});"
    ].join("\n")
  );
  await writeManifest(root, ["openai/gpt-5.1"], "openai/gpt-5.5", ["support-case"]);

  const exit = await Effect.runPromise(
    withEvalService({ bearerCredential: "unused-token" }, (service) =>
      service.runComparison(
        {
          ...requestFor(suite),
          candidateModels: ["openai/gpt-5.1"],
          judgeModel: "openai/gpt-5.5",
          spendLimitUsd: 0
        },
        "pilot"
      )
    ).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /exceeds spendLimitUsd/u);
    assert.match(String(exit.cause), new RegExp(EvalServiceSpendLimitError.name));
  }
});

test("production runner fails closed when a spend limit has unknown pricing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-spend-unknown-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(
    suite,
    [
      'import { test } from "node:test";',
      'import { setupAgent, setupJudge } from "routekit/eval";',
      'const judge = setupJudge({ agent: setupAgent({ model: "unknown/judge" }) });',
      'test("support case", async () => {',
      '  const run = await setupAgent({ model: "unknown/candidate" }).run("Help");',
      "  run.toComplete();",
      '  await judge.autoEvals({ criteria: "Helpful", prompt: "Help", run });',
      "});"
    ].join("\n")
  );
  await writeManifest(root, ["unknown/candidate"], "unknown/judge", ["support-case"]);

  const exit = await Effect.runPromise(
    withEvalService({ bearerCredential: "unused-token" }, (service) =>
      service.runComparison(
        {
          ...requestFor(suite),
          candidateModels: ["unknown/candidate"],
          judgeModel: "unknown/judge",
          spendLimitUsd: 100
        },
        "pilot"
      )
    ).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /pricing is unknown/u);
    assert.match(String(exit.cause), new RegExp(EvalServiceSpendLimitError.name));
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
  const observed: Array<{
    readonly callId?: string;
    readonly phase: "issued" | "completed";
    readonly role: "candidate" | "judge";
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
      outgoing.writeHead(200, {
        "content-type": "application/json",
        "x-routekit-model-call-id": `model-call-${String(calls.length)}`
      });
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
      withEvalService(
        {
          bearerCredential: "parent-only-token",
          observeGatewayCall: (event) =>
            Effect.sync(() => {
              observed.push({
                phase: event.phase,
                role: event.role,
                ...(event.phase === "completed" && event.callId !== undefined
                  ? { callId: event.callId }
                  : {})
              });
            })
        },
        (service) =>
          service.runComparison(
            {
              ...requestFor(suite, `http://127.0.0.1:${String(address.port)}`),
              candidateModels: ["openai/cheap"]
            },
            "pilot"
          )
      ).pipe(Effect.provide(NodeHttpClient.layerUndici))
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
    assert.deepEqual(observed, [
      { phase: "issued", role: "candidate" },
      {
        callId: "model-call-1",
        phase: "completed",
        role: "candidate"
      },
      { phase: "issued", role: "judge" },
      {
        callId: "model-call-2",
        phase: "completed",
        role: "judge"
      }
    ]);
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

test("production runner applies the host timeout at node:test instead of a stale request deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-timeout-"));
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

  const gateway = createServer((incoming, outgoing) => {
    void (async () => {
      const body = JSON.parse(await readBody(incoming)) as Readonly<Record<string, unknown>>;
      await new Promise((resolve) => setTimeout(resolve, 25));
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
      withEvalService(
        {
          bearerCredential: "parent-only-token",
          timeoutMs: 15_000
        },
        (service) =>
          service.runComparison(
            {
              ...requestFor(suite, `http://127.0.0.1:${String(address.port)}`),
              candidateModels: ["openai/cheap"],
              timeoutMs: 5
            },
            "full"
          )
      ).pipe(Effect.provide(NodeHttpClient.layerUndici))
    );

    assert.equal(result.models[0]?.cases[0]?.outcome, "passed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});

test("production runner uses its selected Node runtime for validation before observation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-spawn-failure-"));
  roots.push(root);
  const suite = path.join(root, "support.eval.ts");
  await writeFile(
    suite,
    [
      'import { test } from "node:test";',
      'import { setupAgent } from "routekit/eval";',
      'test("support case", async () => {',
      '  await setupAgent({ model: "openai/cheap" }).run({ prompt: "Help", caseId: "support-case" });',
      "});"
    ].join("\n")
  );
  await writeManifest(root, ["openai/cheap"], "openai/judge", ["support-case"]);
  const observed: unknown[] = [];

  const exit = await Effect.runPromise(
    withEvalService(
      {
        bearerCredential: "parent-only-token",
        execPath: path.join(root, "missing-node"),
        observeGatewayCall: (event) =>
          Effect.sync(() => {
            observed.push(event);
          }),
        timeoutMs: 600_000
      },
      (service) =>
        service.runComparison(
          {
            ...requestFor(suite),
            candidateModels: ["openai/cheap"]
          },
          "full"
        )
    ).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  assert.deepEqual(observed, []);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /validation failed/iu);
    assert.match(String(exit.cause), /could not be loaded safely through node:test/iu);
    assert.match(String(exit.cause), /missing-node/iu);
  }
});

test("production runner isolates qualification from a project SDK with a shorter hidden abort", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-runner-isolated-sdk-"));
  roots.push(root);
  await writeShadowEvalSdk(root, 20);
  const suiteRoot = path.join(
    root,
    ".routekit",
    "evals",
    "plans",
    "plan",
    "dimensions",
    "support"
  );
  await mkdir(suiteRoot, { recursive: true });
  const suite = path.join(suiteRoot, "support.eval.ts");
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
  await writeManifest(suiteRoot, ["openai/cheap"], "openai/judge", ["support-case"]);

  const calls: string[] = [];
  const gateway = createServer((incoming, outgoing) => {
    void (async () => {
      const body = JSON.parse(await readBody(incoming)) as Readonly<Record<string, unknown>>;
      calls.push(String(body.model));
      await new Promise((resolve) => setTimeout(resolve, 75));
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
    const shadowed = await Effect.runPromise(
      withEvalService(
        {
          bearerCredential: "parent-only-token",
          timeoutMs: 15_000
        },
        (service) =>
          service.runComparison(
            {
              ...requestFor(suite, `http://127.0.0.1:${String(address.port)}`),
              candidateModels: ["openai/cheap"],
              timeoutMs: 20
            },
            "full"
          )
      ).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.exit)
    );
    assert.equal(Exit.isFailure(shadowed), true);
    assert.deepEqual(calls, []);

    const started = Date.now();
    const result = await Effect.runPromise(
      withEvalService(
        {
          bearerCredential: "parent-only-token",
          isolateExecutionFromProjectSdk: true,
          timeoutMs: 15_000
        },
        (service) =>
          service.runComparison(
            {
              ...requestFor(suite, `http://127.0.0.1:${String(address.port)}`),
              candidateModels: ["openai/cheap"],
              timeoutMs: 20
            },
            "full"
          )
      ).pipe(Effect.provide(NodeHttpClient.layerUndici))
    );

    assert.deepEqual(calls, ["openai/cheap", "openai/judge"]);
    assert.equal(result.models[0]?.cases[0]?.outcome, "passed");
    assert.ok(Date.now() - started >= 75, "the project SDK's 20ms abort must not bound execution");
  } finally {
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});
