import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  createEvalAuthoring,
  createProductionAuthorTurnAdapter,
  runEvalTool
} from "../../src/authoring.ts";
import type { CreateEvalAuthorTurnInput } from "../../src/public-api.ts";

describe("create-eval library API", () => {
  test("drives durable prepare, run, answer, and status without invoking Ori", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ori-create-eval-library-"));
    const repository = path.join(root, "repository");
    const stateRoot = path.join(root, "state");
    await mkdir(repository);
    await writeFile(path.join(repository, "source.txt"), "unchanged\n");

    const turns: CreateEvalAuthorTurnInput[] = [];
    const responses = [
      {
        exitCode: 0,
        stdout:
          "I inspected the collection surface.\n\n[surface] Which model call should we evaluate?\n1. Support replies\n2. Documentation\n3. Routing\n4. Other\n\nsummary  model=test/author  duration=5ms  $0.001000\n"
      },
      {
        exitCode: 0,
        stdout:
          "The eval and report are complete.\n\nsummary  model=test/author  duration=7ms  $0.002000\n"
      }
    ] as const;
    let tick = 0;
    const originalPersona = process.env.ORI_PERSONA;
    const originalCredential = process.env.OPENROUTER_API_KEY;
    const originalExitCode = process.exitCode;
    const api = createEvalAuthoring({
      clock: {
        now: () => new Date(Date.UTC(2026, 7, 16, 0, 0, tick++))
      },
      environment: {
        OPENROUTER_API_KEY: "test-key",
        ORI_EVAL_API_BASE_URL: "https://gateway.example/api",
        PATH: process.env.PATH
      },
      production: {
        evalToolCommand: [process.execPath, "/ori-owned/eval-tool.mjs"],
        runHeadlessAuthor: async (input) => {
          turns.push(input);
          assert.equal(input.homeDirectory, path.join(input.runDirectory, "ori-home"));
          assert.equal(input.environment.HOME, input.homeDirectory);
          assert.equal(input.environment.ORI_EVAL_TOOL_HOME, input.homeDirectory);
          assert.equal(input.environment.ORI_PERSONA, "code");
          assert.equal(process.env.ANTHROPIC_BASE_URL, "https://gateway.example/api");
          assert.equal(process.env.ORI_EVAL_API_BASE_URL, "https://gateway.example/api");
          assert.equal(process.env.OPENROUTER_API_KEY, "test-key");
          return responses[turns.length - 1]!;
        }
      },
      stateRoot
    });

    try {
      const manifest = await api.manifest();
      assert.equal(manifest.ok, true);
      assert.deepEqual(manifest.host, {
        apiBaseUrl: "https://gateway.example/api",
        apiBaseUrlEnv: "ORI_EVAL_API_BASE_URL",
        credential: "environment",
        credentialEnv: "OPENROUTER_API_KEY"
      });

      const prepared = await api.prepare({
        repository,
        request: "author a support-routing eval"
      });
      assert.equal(prepared.status, "prepared");
      assert.ok(prepared.runDirectory?.startsWith(stateRoot));
      const runDirectory = prepared.runDirectory;
      assert.ok(runDirectory);

      const waiting = await api.run({ runDirectory });
      assert.equal(waiting.status, "waiting", String(waiting.error ?? waiting.status));
      assert.equal(waiting.tag, "surface");
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.environment.ANTHROPIC_BASE_URL, "https://gateway.example/api");
      assert.ok(turns[0]?.prompt.includes("Use the create-eval skill"));
      assert.match(
        await readFile(path.join(runDirectory, "bin", "ori"), "utf8"),
        /\/ori-owned\/eval-tool\.mjs/u
      );

      const clarification = await api.answer({
        answer: "Can you clarify?",
        runDirectory
      });
      assert.equal(clarification.status, "waiting");
      assert.equal(clarification.accepted, false);
      assert.equal(turns.length, 1);

      const accepted = await api.answer({
        answer: "1",
        runDirectory
      });
      assert.equal(accepted.status, "prepared");
      assert.equal(turns.length, 1);

      const completed = await api.run({ runDirectory });
      assert.equal(completed.status, "completed");
      assert.equal(turns.length, 2);
      assert.ok(turns[1]?.prompt.includes("User answer:\n1"));

      const status = await api.status({ runDirectory });
      assert.equal(status.status, "completed");
      assert.equal((status.state as { attempts: readonly unknown[] }).attempts.length, 2);
      assert.equal(await readFile(path.join(repository, "source.txt"), "utf8"), "unchanged\n");
      assert.equal(process.env.ORI_PERSONA, originalPersona);
      assert.equal(process.env.OPENROUTER_API_KEY, originalCredential);
      assert.equal(process.exitCode, originalExitCode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires an injected credential before starting an author turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ori-create-eval-no-auth-"));
    const repository = path.join(root, "repository");
    await mkdir(repository);
    let called = false;
    const api = createEvalAuthoring({
      environment: {},
      production: {
        runHeadlessAuthor: async () => {
          called = true;
          return { exitCode: 0, stdout: "" };
        }
      },
      stateRoot: path.join(root, "state")
    });

    try {
      const prepared = await api.prepare({ repository });
      const runDirectory = prepared.runDirectory;
      assert.ok(runDirectory);
      const result = await api.run({ runDirectory });
      assert.equal(result.status, "auth-required");
      assert.equal(called, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("production adapter owns a dedicated eval worker instead of the Ori executable", () => {
    const production = createProductionAuthorTurnAdapter();
    assert.equal(production.evalCommand.join(" ").includes("ori-eval-system"), false);
    assert.match(production.evalCommand.join(" "), /eval-tool(?:-entry\.ts|\.mjs)/u);
    assert.equal(typeof runEvalTool, "function");
  });
});
