import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Effect, Fiber, Stream } from "effect";

import {
  discoverEvals,
  dryRunEvals,
  EvalDiscoveryError,
  EvalImportError,
  joinOutcomes,
  makeEvalEngineLayer,
  nonPortableImportSpecifiers,
  renderEvalReport,
  runEvals
} from "../index.js";

const withTemp = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "routekit-eval-engine-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const layer = () =>
  makeEvalEngineLayer({
    nodeExecutable: process.execPath,
    environment: {}
  });

const waitForFile = async (path: string, timeoutMs = 5_000): Promise<string> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const waitForProcessExit = async (pid: number, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out waiting for child ${pid} to exit`);
};

test("discovers sorted evals while ignoring caches and VCS directories", async () => {
  await withTemp(async (directory) => {
    await mkdir(join(directory, "nested"), { recursive: true });
    await mkdir(join(directory, "node_modules", "hidden"), { recursive: true });
    await writeFile(join(directory, "z.eval.ts"), "");
    await writeFile(join(directory, "nested", "a.eval.ts"), "");
    await writeFile(join(directory, "nested", "ordinary.test.ts"), "");
    await writeFile(join(directory, "node_modules", "hidden", "ignored.eval.ts"), "");

    const discovery = await Effect.runPromise(
      discoverEvals({ target: directory }).pipe(Effect.provide(layer()))
    );

    assert.deepEqual(
      discovery.files.map((file) => file.slice(directory.length + 1)),
      ["nested/a.eval.ts", "z.eval.ts"]
    );
  });
});

test("reports filesystem failures as Data.TaggedError values", async () => {
  const missing = join(tmpdir(), `missing-routekit-eval-${Date.now()}`);
  const failure = await Effect.runPromise(
    Effect.flip(discoverEvals({ target: missing }).pipe(Effect.provide(layer())))
  );
  assert.ok(failure instanceof EvalDiscoveryError);
  assert.equal(failure._tag, "EvalDiscoveryError");
});

test("detects only module specifiers that are machine-local", () => {
  assert.deepEqual(
    nonPortableImportSpecifiers(`
      import one from "/private/one.js";
      export * from "file:///tmp/two.js";
      const three = import("C:\\\\work\\\\three.js");
      const four = require("../node_modules/four/index.js");
      const harmless = "/not/an/import";
      // import ignored from "/comment.js";
    `),
    ["/private/one.js", "file:///tmp/two.js", "C:\\work\\three.js", "../node_modules/four/index.js"]
  );
});

test("joins candidate and judge rows without inventing outcomes", () => {
  const rows = joinOutcomes([
    {
      requestedModel: "openai/candidate",
      role: "candidate",
      runKey: "cut-off",
      suiteId: "suite",
      caseId: "case"
    },
    {
      requestedModel: "openai/judge",
      role: "judge",
      runKey: "judge"
    },
    {
      model: "openai/judge",
      role: "judge",
      runKey: "judge",
      durationMs: 25,
      toolCalls: ["grade"],
      usage: { costUsd: 0.01 }
    },
    { runKey: "judge", outcome: "passed", score: 0.9 }
  ]);

  assert.deepEqual(rows, [
    {
      cutOff: true,
      model: "openai/candidate",
      outcome: "unknown",
      runKey: "cut-off",
      role: "candidate",
      suiteId: "suite",
      caseId: "case"
    },
    {
      model: "openai/judge",
      role: "judge",
      runKey: "judge",
      durationMs: 25,
      toolCalls: ["grade"],
      usage: { costUsd: 0.01 },
      cutOff: false,
      outcome: "passed",
      score: 0.9
    }
  ]);
});

test("renders roles, outcomes, usage, and unknown measurements in reports", () => {
  const report = renderEvalReport({
    searchRoot: "/work/evals",
    workingDirectory: "/work",
    files: ["/work/evals/one.eval.ts"],
    exitCode: 1,
    durationMs: 50,
    stdout: "",
    stderr: "",
    tests: [{ name: "one", status: "fail" }],
    results: [
      {
        model: "openai/judge",
        role: "judge",
        runKey: "judge-1",
        cutOff: false,
        outcome: "failed",
        toolCalls: ["grade"],
        usage: { costUsd: 0.01 }
      }
    ]
  });
  assert.match(report, /\| judge \| openai\/judge \| failed \| unknown \|/u);
  assert.match(report, /\| 1 \| 0\.01 USD \|/u);
  assert.doesNotMatch(report, /unknown.*0 ms/u);
});

test("runs node:test and reconciles Ori-compatible JSONL details", async () => {
  await withTemp(async (directory) => {
    const evalFile = join(directory, "model.eval.ts");
    await writeFile(
      evalFile,
      `
        import { appendFileSync } from "node:fs";
        import test from "node:test";
        const resultFile = process.env.ORI_EVAL_RESULTS_FILE;
        if (!resultFile) throw new Error("missing result channel");
        test("candidate answer", () => {
          appendFileSync(resultFile, JSON.stringify({
            requestedModel: "openai/gpt-4.1",
            role: "candidate",
            runKey: "run-1",
            suiteId: "routing",
            caseId: "one",
            host: { runner: "node:test" }
          }) + "\\n");
          appendFileSync(resultFile, JSON.stringify({
            model: "openai/gpt-4.1",
            runKey: "run-1",
            durationMs: 12,
            toolCalls: ["search"],
            terminal: {
              type: "session.completed",
              model: "openai/gpt-4.1",
              payload: {
                usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 }
              }
            }
          }) + "\\n");
          appendFileSync(resultFile, JSON.stringify({
            runKey: "run-1",
            outcome: "passed",
            score: 1
          }) + "\\n");
        });
      `
    );

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(runEvals({ target: evalFile })).pipe(Effect.provide(layer()))
      )
    );
    assert.deepEqual(
      events.map((event) => event._tag),
      ["EvalDiscovered", "EvalRunStarted", "EvalRunCompleted"]
    );
    const completed = events[2];
    assert.equal(completed?._tag, "EvalRunCompleted");
    if (completed?._tag !== "EvalRunCompleted") return;
    assert.equal(completed.summary.exitCode, 0);
    assert.equal(completed.summary.tests[0]?.status, "pass");
    assert.deepEqual(completed.summary.results[0], {
      model: "openai/gpt-4.1",
      role: "candidate",
      runKey: "run-1",
      suiteId: "routing",
      caseId: "one",
      host: { runner: "node:test" },
      durationMs: 12,
      toolCalls: ["search"],
      terminal: {
        type: "session.completed",
        model: "openai/gpt-4.1",
        payload: {
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 }
        }
      },
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
      cutOff: false,
      outcome: "passed",
      score: 1
    });
  });
});

test("dry-run loads top-level code but does not execute test bodies", async () => {
  await withTemp(async (directory) => {
    const marker = join(directory, "marker.txt");
    const evalFile = join(directory, "dry.eval.ts");
    await writeFile(
      evalFile,
      `
        import { appendFileSync } from "node:fs";
        import test from "node:test";
        appendFileSync(process.env.MARKER, "top\\n");
        test("must not run", () => appendFileSync(process.env.MARKER, "body\\n"));
      `
    );

    const events = Array.from(
      await Effect.runPromise(
        Stream.runCollect(
          dryRunEvals({
            target: evalFile,
            environment: { MARKER: marker }
          })
        ).pipe(Effect.provide(layer()))
      )
    );
    assert.equal(events.at(-1)?._tag, "EvalDryRunCompleted");
    assert.equal(await readFile(marker, "utf8"), "top\n");
  });
});

test("non-portable imports fail in the typed channel before spawning", async () => {
  await withTemp(async (directory) => {
    const evalFile = join(directory, "portable.eval.ts");
    await writeFile(evalFile, 'import "/private/machine-only.js";\n');
    const failure = await Effect.runPromise(
      Effect.flip(Stream.runDrain(runEvals({ target: evalFile })).pipe(Effect.provide(layer())))
    );
    assert.ok(failure instanceof EvalImportError);
    assert.equal(failure._tag, "EvalImportError");
  });
});

test("interrupting a run closes the child scope and terminates the child", async () => {
  await withTemp(async (directory) => {
    const ready = join(directory, "ready.txt");
    const evalFile = join(directory, "interrupt.eval.ts");
    await writeFile(
      evalFile,
      `
        import { writeFileSync } from "node:fs";
        import test from "node:test";
        writeFileSync(process.env.READY, String(process.pid));
        test("wait", async () => {
          await new Promise(() => {});
        });
      `
    );

    const fiber = Effect.runFork(
      Stream.runDrain(
        runEvals({
          target: evalFile,
          environment: { READY: ready },
          timeoutMs: 60_000
        })
      ).pipe(Effect.provide(layer()))
    );
    const pid = Number(await waitForFile(ready));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitForProcessExit(pid);
  });
});

test("public programs are Effect values and Streams, not Promise facades", () => {
  const discovery = discoverEvals({ target: "." });
  const run = runEvals({ target: "." });
  assert.equal("then" in (discovery as object), false);
  assert.equal("then" in (run as object), false);
});
