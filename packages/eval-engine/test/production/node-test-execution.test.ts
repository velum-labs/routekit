import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect, Exit, Fiber, Stream } from "effect";

import { makeNodeTestExecutionPort } from "../../src/library/node-test-execution.ts";
import { makeRouteKitEvalExecutionPort } from "../../src/library/routekit-execution.ts";
import { joinOutcomes } from "../../src/vendor/framework/cli/src/commands/eval/results-lines.ts";

const makeDiscovery = async (source?: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-node-test-"));
  const file = path.join(root, "empty.eval.ts");
  await writeFile(file, source ?? 'import { test } from "node:test"; test("empty", () => {});');
  return {
    files: [file],
    searchRoot: root,
    workingDirectory: root
  };
};

const request = (suitePath: string) => ({
  version: 1 as const,
  profileId: "support",
  suitePath,
  candidateModels: ["openai/candidate"],
  judgeModel: "openai/judge",
  gatewayUrl: "http://127.0.0.1:8080"
});

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );

const startRuntimeBridge = async (answer: string) => {
  const requests: Array<Readonly<Record<string, unknown>>> = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>
      );
      const events = [
        {
          type: "runtime.event",
          event: {
            type: "assistant.text.delta",
            payload: { delta: answer }
          }
        },
        {
          type: "runtime.event",
          event: {
            type: "turn.succeeded",
            model: "openai/candidate",
            harness: "routekit-gateway",
            payload: {}
          }
        }
      ];
      outgoing.writeHead(200, {
        "content-type": "application/x-ndjson"
      });
      outgoing.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    close: () => closeServer(server),
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests
  };
};

const runExecution = <A, E>(stream: Stream.Stream<A, E>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((events) => ({
      events,
      results: joinOutcomes(events as Parameters<typeof joinOutcomes>[0])
    }))
  );

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("condition did not become true before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("node:test execution rejects credentials before spawning a child", async () => {
  const suite = await makeDiscovery();
  const port = makeNodeTestExecutionPort({
    bridgeOrigin: "http://127.0.0.1:12345",
    childEnvironment: {
      AWS_SECRET_ACCESS_KEY: "also-must-not-enter-child",
      ROUTEKIT_PROJECT_LABEL: "safe",
      ROUTEKIT_TOKEN: "must-not-enter-child"
    },
    execPath: "/path/that/must/not/run"
  });
  const exit = await Effect.runPromise(
    port
      .execute({
        comparisonId: "comparison-1",
        discovery: suite,
        request: request(suite.searchRoot)
      })
      .pipe(Stream.runDrain, Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /AWS_SECRET_ACCESS_KEY|ROUTEKIT_TOKEN/u);
    assert.doesNotMatch(String(exit.cause), /must-not-enter-child/u);
    assert.doesNotMatch(String(exit.cause), /also-must-not-enter-child/u);
  }
});

test("node:test execution rejects credential-bearing bridge URLs", async () => {
  const suite = await makeDiscovery();
  const port = makeNodeTestExecutionPort({
    bridgeOrigin: "http://owner-token@127.0.0.1:12345",
    execPath: "/path/that/must/not/run"
  });
  const exit = await Effect.runPromise(
    port
      .execute({
        comparisonId: "comparison-1",
        discovery: suite,
        request: request(suite.searchRoot)
      })
      .pipe(Stream.runDrain, Effect.exit)
  );

  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.match(String(exit.cause), /credential-free HTTP\(S\) origin/u);
    assert.doesNotMatch(String(exit.cause), /owner-token/u);
  }
});

test("concurrent executions isolate bridges, comparison ids, results, and SDK links", async () => {
  const alpha = await startRuntimeBridge("alpha answer");
  const beta = await startRuntimeBridge("beta answer");
  const source = (answer: string) =>
    [
      'import { test } from "node:test";',
      'import { setupAgent } from "routekit/eval";',
      'test("isolated case", async () => {',
      '  const run = await setupAgent({ model: "openai/candidate" }).run("answer");',
      "  run.toComplete();",
      `  run.toMention(${JSON.stringify(answer)});`,
      "});"
    ].join("\n");
  const alphaSuite = await makeDiscovery(source("alpha answer"));
  const betaSuite = await makeDiscovery(source("beta answer"));

  try {
    const [alphaOutput, betaOutput] = await Effect.runPromise(
      Effect.all(
        [
          runExecution(makeNodeTestExecutionPort({ bridgeOrigin: alpha.origin }).execute({
            comparisonId: "comparison-alpha",
            discovery: alphaSuite,
            request: request(alphaSuite.searchRoot)
          })),
          runExecution(makeNodeTestExecutionPort({ bridgeOrigin: beta.origin }).execute({
            comparisonId: "comparison-beta",
            discovery: betaSuite,
            request: request(betaSuite.searchRoot)
          }))
        ],
        { concurrency: "unbounded" }
      )
    );

    assert.deepEqual(
      alpha.requests.map(({ comparisonId }) => comparisonId),
      ["comparison-alpha"]
    );
    assert.deepEqual(
      beta.requests.map(({ comparisonId }) => comparisonId),
      ["comparison-beta"]
    );
    assert.deepEqual(
      alphaOutput.results.map(({ model, outcome }) => ({
        model,
        outcome
      })),
      [{ model: "openai/candidate", outcome: "passed" }]
    );
    assert.deepEqual(
      betaOutput.results.map(({ model, outcome }) => ({
        model,
        outcome
      })),
      [{ model: "openai/candidate", outcome: "passed" }]
    );
    assert.equal(alphaOutput.events.length >= 2, true);
    assert.equal(betaOutput.events.length >= 2, true);
    assert.equal(
      await exists(path.join(alphaSuite.workingDirectory, "node_modules", "routekit")),
      false
    );
    assert.equal(
      await exists(path.join(betaSuite.workingDirectory, "node_modules", "routekit")),
      false
    );
  } finally {
    await Promise.all([
      alpha.close(),
      beta.close(),
      rm(alphaSuite.workingDirectory, { recursive: true, force: true }),
      rm(betaSuite.workingDirectory, { recursive: true, force: true })
    ]);
  }
});

test("interrupting execution terminates the hanging child and cleans scoped artifacts", async () => {
  const markerRoot = await mkdtemp(path.join(os.tmpdir(), "routekit-child-marker-"));
  const marker = path.join(markerRoot, "child.json");
  const argvMarker = path.join(markerRoot, "argv.txt");
  const wrapper = path.join(markerRoot, "node-wrapper");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvMarker)}`,
      `exec ${JSON.stringify(globalThis.process.execPath)} "$@"`
    ].join("\n")
  );
  await chmod(wrapper, 0o755);
  const suite = await makeDiscovery(
    [
      'import { writeFileSync } from "node:fs";',
      'import { test } from "node:test";',
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      "  pid: process.pid,",
      "  resultsPath: process.env.ROUTEKIT_EVAL_RESULTS_FILE,",
      "  runtimeOrigin: process.env.ROUTEKIT_EVAL_RUNTIME_ORIGIN,",
      "}));",
      'test("hangs", async () => {',
      "  await new Promise(() => {});",
      "});"
    ].join("\n")
  );
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const port = yield* makeRouteKitEvalExecutionPort({
        bearerCredential: "parent-only-test-token",
        execPath: wrapper
      });
      return yield* Stream.runDrain(port.execute({
        comparisonId: "comparison-hanging",
        discovery: suite,
        request: {
          ...request(suite.searchRoot),
          timeoutMs: 60_000
        }
      }));
    }).pipe(Effect.provide(NodeHttpClient.layerUndici))
  );

  try {
    await waitUntil(async () => (await exists(marker)) && (await exists(argvMarker)));
    const child = JSON.parse(await readFile(marker, "utf8")) as {
      readonly pid: number;
      readonly resultsPath: string;
      readonly runtimeOrigin: string;
    };
    const pid = child.pid;
    assert.equal(Number.isInteger(pid) && pid > 0, true);
    assert.match(path.basename(path.dirname(child.resultsPath)), /^routekit-eval-results-/u);

    const args = (await readFile(argvMarker, "utf8")).trim().split("\n");
    const junitPath = args
      .find((argument) => argument.startsWith("--test-reporter-destination="))
      ?.slice("--test-reporter-destination=".length);
    assert.notEqual(junitPath, undefined);
    assert.match(path.basename(path.dirname(junitPath ?? "")), /^routekit-eval-junit-/u);

    const sdkLink = path.join(suite.workingDirectory, "node_modules", "routekit");
    const sdkPackageDirectory = await readlink(sdkLink);
    const sdkDirectory = path.dirname(path.dirname(sdkPackageDirectory));
    assert.match(path.basename(sdkDirectory), /^routekit-eval-sdk-/u);
    assert.equal(await exists(path.dirname(child.resultsPath)), true);
    assert.equal(await exists(path.dirname(junitPath ?? "")), true);
    assert.equal(await exists(sdkDirectory), true);
    const liveBridge = await fetch(`${child.runtimeOrigin}/not-a-route`);
    assert.equal(liveBridge.status >= 400, true);

    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.throws(
      () => process.kill(pid, 0),
      (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ESRCH"
    );
    await assert.rejects(fetch(`${child.runtimeOrigin}/not-a-route`));

    assert.equal(await exists(sdkLink), false);
    assert.equal(await exists(sdkDirectory), false);
    assert.equal(await exists(path.dirname(child.resultsPath)), false);
    assert.equal(await exists(path.dirname(junitPath ?? "")), false);
  } finally {
    if (fiber.pollUnsafe() === undefined) {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    await Promise.all([
      rm(markerRoot, { recursive: true, force: true }),
      rm(suite.workingDirectory, { recursive: true, force: true })
    ]);
  }
});
