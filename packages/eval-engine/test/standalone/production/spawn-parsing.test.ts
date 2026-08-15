import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { spawnWorkflowInternals } from "../../../src/vendor/eval-system/spawn-workflow.ts";

const {
  attemptTotals,
  cheaperRerunLine,
  classifyProviderFailure,
  classifySpawnReply,
  copyRepositoryTree,
  discoverScratchWorkspace,
  evalRunTotals,
  isInsideRoot,
  parseQuestion,
  parseQuestionOptions,
  parseSummary,
  renderCostTable,
  replaceBakeoff,
} = spawnWorkflowInternals;

describe("outer protocol parsing without substituting execution", () => {
  test("reads every measured field from a real routekit-eval code summary shape", () => {
    assert.deepEqual(
      parseSummary(
        [
          "assistant answer",
          "summary  model=openai/gpt-5.6-terra  requested-model=openai/gpt-5.6-terra  duration=1840ms  input=1250 tok  output=340 tok  context=4096 tok  $0.001234",
        ].join("\n"),
      ),
      {
        model: "openai/gpt-5.6-terra",
        requestedModel: "openai/gpt-5.6-terra",
        durationMs: 1840,
        inputTokens: 1250,
        outputTokens: 340,
        contextTokens: 4096,
        costUsd: 0.001234,
      },
    );
  });

  test("preserves unknown cost instead of inventing zero", () => {
    const summary = parseSummary(
      "summary  requested-model=provider/model  duration=2100ms  input=980 tok",
    );
    assert.deepEqual(summary, {
      requestedModel: "provider/model",
      durationMs: 2100,
      inputTokens: 980,
    });
    assert.ok(!Object.hasOwn(summary, "costUsd"));
  });

  test("relays only the first tagged question and records a contract violation", () => {
    assert.deepEqual(
      parseQuestion(
        [
          "I found these surfaces:",
          "",
          "| Surface | Model |",
          "| --- | --- |",
          "| Triage | current/model |",
          "",
          "[surface] Which one?",
          "",
          "1. Triage",
          "2. Stop",
          "3. Inspect prompt",
          "4. Other",
          "",
          "[workspace-data] Which data?",
        ].join("\n"),
      ),
      {
        context:
          "I found these surfaces:\n\n| Surface | Model |\n| --- | --- |\n| Triage | current/model |",
        tag: "surface",
        text: "[surface] Which one?\n\n1. Triage\n2. Stop\n3. Inspect prompt\n4. Other",
        violation: "one-question contract violated: emitted 2 tagged questions",
      },
    );
  });

  test("relays an untagged final question but marks it invalid", () => {
    assert.deepEqual(parseQuestion("Here is the context.\n\nWhich surface should I measure?"), {
      context: "Here is the context.",
      tag: "untagged",
      text: "Which surface should I measure?",
      violation: "one-question contract violated: final question had no recognized tag",
    });
  });

  test("does not turn a completed answer into a question", () => {
    assert.equal(parseQuestion("The eval is complete.\nsummary  duration=10ms"), undefined);
  });

  test("finds the production scratch path and aggregates only measured attempts", () => {
    assert.equal(
      discoverScratchWorkspace("Created /tmp/routekit-eval-eval-scratch-AbC_123 and wrote report.md"),
      "/tmp/routekit-eval-eval-scratch-AbC_123",
    );
    assert.deepEqual(
      attemptTotals([
        {
          answerFile: "answer-1.txt",
          durationMs: 10,
          endedAt: "2026-08-12T00:00:01.000Z",
          errorFile: "error-1.log",
          exitCode: 0,
          number: 1,
          startedAt: "2026-08-12T00:00:00.000Z",
          summary: { costUsd: 0.1, durationMs: 1000 },
        },
        {
          answerFile: "answer-2.txt",
          durationMs: 20,
          endedAt: "2026-08-12T00:00:03.000Z",
          errorFile: "error-2.log",
          exitCode: 1,
          number: 2,
          startedAt: "2026-08-12T00:00:01.000Z",
        },
      ]),
      {
        costUsd: 0.1,
        durationMs: 1000,
        unmeasuredAttempts: 1,
      },
    );
  });

  test("projects measured candidate and judge totals from structured eval rows", () => {
    assert.deepEqual(
      evalRunTotals([
        {
          endedAt: "2026-08-12T00:00:00.000Z",
          exitCode: 0,
          files: ["/tmp/example.eval.ts"],
          results: [
            {
              durationMs: 1200,
              role: "candidate",
              usage: { costUsd: 0.02 },
            },
            {
              durationMs: 800,
              role: "judge",
              usage: { costUsd: 0.03 },
            },
            {
              role: "candidate",
            },
          ],
          tests: [],
          workingDirectory: "/tmp",
        },
      ]),
      {
        candidateCostUsd: 0.02,
        candidateDurationMs: 1200,
        judgeCostUsd: 0.03,
        judgeDurationMs: 800,
        runs: 1,
      },
    );
  });

  test("extracts three concrete options and a short prompt from a tagged question", () => {
    assert.deepEqual(
      parseQuestionOptions(
        "[surface] Which one?\n\n1. Triage\n2. Stop\n3. Inspect prompt\n4. Other",
      ),
      {
        options: ["Triage", "Stop", "Inspect prompt"],
        prompt: "Which one?",
      },
    );
  });

  test("treats numbered options as answers and clarification as not-an-answer", () => {
    const questionText = "[surface] Which one?\n\n1. Triage\n2. Stop\n3. Inspect prompt\n4. Other";
    assert.equal(classifySpawnReply({ questionText, reply: "1" }), "answer");
    assert.equal(classifySpawnReply({ questionText, reply: "Triage" }), "answer");
    assert.equal(classifySpawnReply({ questionText, reply: "other: mine" }), "answer");
    assert.equal(classifySpawnReply({ questionText, reply: "what do you mean?" }), "not-an-answer");
    assert.equal(
      classifySpawnReply({ questionText, reply: "I didn't ask for this" }),
      "not-an-answer",
    );
    assert.equal(classifySpawnReply({ questionText, reply: "why this table?" }), "not-an-answer");
  });

  test("rewrites bakeoff and renders the cheaper-rerun cost table", () => {
    assert.equal(replaceBakeoff("The bakeoff is launched."), "The model comparison is launched.");
    assert.equal(isInsideRoot("/tmp/repo", "/tmp/repo/src"), true);
    assert.equal(isInsideRoot("/tmp/repo", "/tmp/other"), false);
    const table = renderCostTable({
      attempts: [
        {
          startedAt: "2026-08-12T20:29:00.000Z",
          summary: { costUsd: 0.42, durationMs: 39000 },
        },
        {
          startedAt: "2026-08-12T20:30:00.000Z",
          summary: { costUsd: 3.2, durationMs: 910000 },
        },
      ],
      candidateCostUsd: 0.46,
      candidateDurationMs: 120000,
      judgeCostUsd: 0.05,
      judgeDurationMs: 60000,
      stoppedForQuestion: false,
      totalCostUsd: 4.13,
      unmeasuredAttempts: 0,
    });
    assert.match(table, /Reading the project, stopped to ask you a question/);
    assert.match(table, /Eval model calls/);
    assert.match(table, /\*\*\$4\.13\*\*/);
    assert.equal(
      cheaperRerunLine({ evalCostUsd: 0.51, totalCostUsd: 4.13 }),
      "The run cost $4.13 in total, and a rerun costs only $0.51.",
    );
  });

  test("copies the private tree without recreating external symlinks", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-eval-copy-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-eval-copy-dst-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-eval-copy-out-"));
    try {
      await mkdir(path.join(source, "src"));
      await mkdir(path.join(source, "node_modules"));
      await writeFile(path.join(source, "src", "main.ts"), "export {}\n");
      await writeFile(path.join(source, "node_modules", "pkg.js"), "ignored\n");
      await writeFile(path.join(source, "src", "inside.ts"), "inside\n");
      await symlink("inside.ts", path.join(source, "src", "local-link"));
      await writeFile(path.join(outside, "secret.txt"), "no\n");
      await symlink(path.join(outside, "secret.txt"), path.join(source, "leak"));
      const skipped = await copyRepositoryTree(source, dest);
      assert.deepEqual(skipped, [{ path: "leak", target: path.join(outside, "secret.txt") }]);
      assert.equal(await readFile(path.join(dest, "src", "main.ts"), "utf8"), "export {}\n");
      assert.equal(await readlink(path.join(dest, "src", "local-link")), "inside.ts");
      await assert.rejects(lstat(path.join(dest, "leak")));
      await assert.rejects(lstat(path.join(dest, "node_modules")));
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("classifies recoverable credit, rate-limit, and timeout failures", () => {
    assert.deepEqual(
      classifyProviderFailure(
        "Payment required. Manage it using the RouteKit gateway account",
      ),
      { kind: "insufficient-credit", recoverable: true },
    );
    assert.deepEqual(classifyProviderFailure("HTTP 429 rate limit from provider"), {
      kind: "rate-limit",
      recoverable: true,
    });
    assert.deepEqual(classifyProviderFailure("the provider timed out after 120s"), {
      kind: "provider-timeout",
      recoverable: true,
    });
    assert.equal(
      classifyProviderFailure("The eval is complete.\nsummary  duration=10ms"),
      undefined,
    );
  });
});
