import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVAL_CONTRACT_VERSION } from "@velum-labs/routekit-eval-contracts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, Fiber, Stream } from "effect";

import {
  EvalRepository,
  EvalRunImmutableError,
  EvalService,
  InvalidEvalRunIdError,
  isValidEvalRunId,
  makeEvalRepositoryLayer,
  makeEvalServiceLayer,
  runEvalPath,
  validateEvalRunId
} from "../index.js";

const workload = {
  workloadId: "support-answer",
  suiteId: "support",
  candidateModel: "openai/candidate",
  judgeModel: "openai/judge"
} as const;

test("run ID validation accepts generated and explicit import namespaces", async () => {
  assert.equal(isValidEvalRunId("eval_0123456789abcdef"), true);
  assert.equal(isValidEvalRunId("import_legacy-2026_08"), true);
  for (const invalid of [
    "../escape",
    "..\\escape",
    "eval_test",
    "eval_0123456789ABCDE",
    "import_",
    "import_../escape"
  ]) {
    assert.equal(isValidEvalRunId(invalid), false);
    const failure = await runRouteKitEffect(Effect.flip(validateEvalRunId(invalid)));
    assert.ok(failure instanceof InvalidEvalRunIdError);
  }
});

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("mock server did not bind"));
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );

test("runs Ori author files, normalizes roles, and stores immutable evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-service-"));
  const requests: Array<{
    readonly model: string;
    readonly attribution: string | undefined;
    readonly bypass: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as { model: string };
      requests.push({
        model: payload.model,
        attribution:
          typeof request.headers["x-routekit-eval-attribution"] === "string"
            ? request.headers["x-routekit-eval-attribution"]
            : undefined,
        bypass:
          typeof request.headers["x-routekit-eval-policy-bypass"] === "string"
            ? request.headers["x-routekit-eval-policy-bypass"]
            : undefined
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  payload.model === "openai/judge"
                    ? JSON.stringify({ score: 0.9, reason: "grounded" })
                    : "candidate answer"
              },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 }
        })
      );
    });
  });

  try {
    const port = await listen(server);
    const evalFile = join(root, "answer.eval.ts");
    const repositoryRoot = join(root, "repository");
    writeFileSync(
      evalFile,
      `
        import { test } from "node:test";
        import { setupAgent, setupJudge } from "ori/eval";
        const agent = setupAgent();
        const judge = setupJudge({ minScore: 0.8 });
        test("answers and is judged", async () => {
          const run = await agent.run("answer the support question", { caseId: "refund" });
          run.toComplete();
          run.toMention("candidate");
          await judge.autoEvals({ criteria: "Be grounded", run });
        });
      `
    );
    const layer = makeEvalServiceLayer({
      repositoryRoot,
      nodeExecutable: process.execPath,
      gatewayUrl: `http://127.0.0.1:${port}`,
      gatewayToken: "local-test-token"
    });
    const events = Array.from(
      await runRouteKitEffect(
        Stream.runCollect(runEvalPath({ target: evalFile, workload })).pipe(Effect.provide(layer))
      )
    );
    const completed = events.find((event) => event._tag === "EvalRunCompleted");
    assert.ok(completed);
    assert.equal(completed.run.manifest.workloadId, "support-answer");
    assert.equal(completed.run.manifest.suiteId, "support");
    assert.equal(completed.run.manifest.candidateModel, "openai/candidate");
    assert.equal(completed.run.manifest.judgeModel, "openai/judge");
    assert.equal(completed.run.manifest.suiteDigest.length, 64);
    assert.deepEqual(completed.observations.map((observation) => observation.role).sort(), [
      "candidate",
      "judge"
    ]);
    assert.deepEqual(completed.observations.map((observation) => observation.model).sort(), [
      "openai/candidate",
      "openai/judge"
    ]);
    assert.equal(
      completed.observations.every((observation) => observation.usage?.costUsd === undefined),
      true
    );
    assert.deepEqual(
      requests.map((request) => request.model),
      ["openai/candidate", "openai/judge"]
    );
    assert.equal(
      requests.every((request) => request.bypass === "1"),
      true
    );
    assert.deepEqual(
      requests.map((request) => JSON.parse(request.attribution ?? "{}").role),
      ["candidate", "judge"]
    );

    const rawPath = completed.persisted.rawPath;
    const observationsPath = completed.persisted.observationsPath;
    assert.equal(statSync(repositoryRoot).mode & 0o777, 0o700);
    assert.equal(statSync(completed.persisted.runDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(rawPath).mode & 0o777, 0o600);
    assert.equal(statSync(observationsPath).mode & 0o777, 0o600);

    const importedId = "import_legacy-2026_08";
    mkdirSync(join(repositoryRoot, "runs", importedId));
    mkdirSync(join(repositoryRoot, "runs", "not-a-valid-run"));
    const escapedDirectory = join(repositoryRoot, "outside");
    mkdirSync(escapedDirectory);
    writeFileSync(join(escapedDirectory, "raw.json"), `${JSON.stringify(completed.run)}\n`);
    writeFileSync(
      join(escapedDirectory, "observations.json"),
      `${JSON.stringify({
        version: EVAL_CONTRACT_VERSION,
        runId: completed.run.manifest.runId,
        observations: completed.observations
      })}\n`
    );

    const repositoryProgram = Effect.gen(function* () {
      const repository = yield* EvalRepository;
      const stored = yield* repository.readRun(completed.run.manifest.runId);
      assert.deepEqual(stored, completed.run);
      assert.equal(yield* repository.readRun(importedId), undefined);
      assert.deepEqual(yield* repository.listRunIds, [completed.run.manifest.runId, importedId]);
      const traversalRun = yield* Effect.flip(repository.readRun("../outside"));
      const traversalObservations = yield* Effect.flip(repository.readObservations("../outside"));
      const invalidSave = yield* Effect.flip(
        repository.save(
          {
            ...completed.run,
            manifest: { ...completed.run.manifest, runId: "../outside" }
          },
          {
            version: EVAL_CONTRACT_VERSION,
            runId: "../outside",
            observations: completed.observations
          }
        )
      );
      const duplicate = yield* Effect.flip(
        repository.save(completed.run, {
          version: EVAL_CONTRACT_VERSION,
          runId: completed.run.manifest.runId,
          observations: completed.observations
        })
      );
      return { duplicate, invalidSave, traversalObservations, traversalRun };
    }).pipe(Effect.provide(makeEvalRepositoryLayer({ root: repositoryRoot })));
    const failures = await runRouteKitEffect(repositoryProgram);
    assert.ok(failures.duplicate instanceof EvalRunImmutableError);
    assert.ok(failures.invalidSave instanceof InvalidEvalRunIdError);
    assert.ok(failures.traversalRun instanceof InvalidEvalRunIdError);
    assert.ok(failures.traversalObservations instanceof InvalidEvalRunIdError);

    writeFileSync(observationsPath, "{}\n", { mode: 0o600 });
    await assert.rejects(
      runRouteKitEffect(
        Effect.gen(function* () {
          const service = yield* EvalService;
          return yield* service.readObservations(completed.run.manifest.runId);
        }).pipe(Effect.provide(layer))
      ),
      /Could not read evaluation evidence/
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
};

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} did not exit`);
};

test("interruption terminates the engine child and removes the scoped author SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-service-interrupt-"));
  const ready = join(root, "ready");
  const evalFile = join(root, "interrupt.eval.ts");
  const sdkDirectoriesBefore = new Set(
    readdirSync(tmpdir()).filter((entry) => entry.startsWith("routekit-ori-sdk-"))
  );
  try {
    writeFileSync(
      evalFile,
      `
        import { writeFileSync } from "node:fs";
        import { test } from "node:test";
        import { setupAgent } from "ori/eval";
        setupAgent();
        writeFileSync(process.env.READY, String(process.pid));
        test("waits", async () => await new Promise(() => {}));
      `
    );
    const layer = makeEvalServiceLayer({
      repositoryRoot: join(root, "repository"),
      nodeExecutable: process.execPath,
      gatewayUrl: "http://127.0.0.1:9",
      gatewayToken: "unused",
      environment: { READY: ready }
    });
    const fiber = Effect.runFork(
      Stream.runDrain(
        runEvalPath({
          target: evalFile,
          workload,
          timeoutMs: 60_000
        })
      ).pipe(Effect.provide(layer))
    );
    const pid = Number(await waitForFile(ready));
    await runRouteKitEffect(Fiber.interrupt(fiber));
    await waitForExit(pid);
    const sdkDirectoriesAfter = readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith("routekit-ori-sdk-")
    );
    assert.deepEqual(
      sdkDirectoriesAfter.filter((entry) => !sdkDirectoriesBefore.has(entry)),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public operations are Effect and Stream values, not Promise facades", () => {
  const layer = makeEvalServiceLayer({
    repositoryRoot: "/tmp/unused-routekit-eval",
    nodeExecutable: process.execPath,
    gatewayUrl: "http://127.0.0.1:9",
    gatewayToken: "unused"
  });
  const effect = Effect.gen(function* () {
    const service = yield* EvalService;
    return yield* service.list({ target: "." });
  }).pipe(Effect.provide(layer));
  const stream = runEvalPath({ target: ".", workload }).pipe(Stream.provide(layer));
  assert.equal("then" in (effect as object), false);
  assert.equal("then" in (stream as object), false);
});
