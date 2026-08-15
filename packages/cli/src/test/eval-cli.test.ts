import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { immutableCliRuntime } from "@velum-labs/routekit-cli-core";
import { EVAL_POLICY } from "@velum-labs/routekit-eval-contracts";
import { Effect } from "effect";

import { buildProgram } from "../cli.js";
import { policyShowCommand } from "../effect/eval-cli.js";

const command = (name: string) => {
  const found = buildProgram().commands.find((entry) => entry.name() === name);
  assert.ok(found, `missing command ${name}`);
  return found;
};

const runtimeFor = (root: string, stdout: string[]) =>
  immutableCliRuntime({
    stdout: { write: (value) => (stdout.push(String(value)), true) },
    stderr: { write: () => true },
    env: {
      ROUTEKIT_HOME: join(root, "routekit-home"),
      ROUTEKIT_TELEMETRY: "0"
    },
    platform: "linux",
    arch: "x64",
    nodeVersion: "22.22.2"
  });

const runJson = async (root: string, args: readonly string[]): Promise<unknown> => {
  const stdout: string[] = [];
  await buildProgram(runtimeFor(root, stdout))
    .exitOverride()
    .parseAsync(["node", "routekit", "--json", ...args]);
  return JSON.parse(stdout.join("")) as unknown;
};

test("policy show command remains an Effect program with the isolation contract", async () => {
  assert.deepEqual(await Effect.runPromise(policyShowCommand), EVAL_POLICY);
});

test("eval command tree exposes the complete setup workflow", () => {
  const evalCommand = command("eval");
  assert.deepEqual(
    evalCommand.commands.map((entry) => entry.name()),
    ["prepare", "status", "answer", "validate", "estimate", "run", "publish"]
  );
  const help = evalCommand.helpInformation();
  for (const subcommand of [
    "prepare",
    "status",
    "answer",
    "validate",
    "estimate",
    "run",
    "publish"
  ]) {
    assert.match(help, new RegExp(`^\\s+${subcommand}\\b`, "mu"));
  }
  assert.doesNotMatch(help, /^\s+show\b/mu);
});

test("eval workflow help documents identity, model-call, and approval inputs", () => {
  const evalCommand = command("eval");
  const subcommand = (name: string) => {
    const found = evalCommand.commands.find((entry) => entry.name() === name);
    assert.ok(found, `missing eval ${name}`);
    return found;
  };

  for (const name of ["prepare", "status", "answer", "validate", "estimate", "run", "publish"]) {
    const help = subcommand(name).helpInformation();
    assert.match(help, /--profile <id>/u);
    assert.match(help, /--repository <path>/u);
  }
  assert.match(subcommand("answer").helpInformation(), /--answer <text>/u);
  assert.match(subcommand("estimate").helpInformation(), /--mode <mode>/u);
  assert.match(subcommand("run").helpInformation(), /--token <token>/u);
  assert.match(subcommand("run").helpInformation(), /--url <gateway>/u);
});

test("prepare, answer, status, and prepare resume durable setup without network access", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-workflow-"));
  try {
    writeFileSync(
      join(root, "support.ts"),
      'client.responses.create({ model: "openai/current" });\n'
    );
    const common = ["--profile", "support", "--repository", root] as const;

    const prepared = (await runJson(root, ["eval", "prepare", ...common])) as {
      state: { stage: string; revision: number };
      question: { id: string };
      inspection: { surfaces: Array<{ model?: string }> };
    };
    assert.equal(prepared.state.stage, "surface");
    assert.equal(prepared.state.revision, 0);
    assert.equal(prepared.question.id, "surface");
    assert.equal(prepared.inspection.surfaces[0]?.model, "openai/current");

    const answered = (await runJson(root, [
      "eval",
      "answer",
      ...common,
      "--answer",
      "support replies"
    ])) as {
      state: { stage: string; revision: number; answers: Record<string, string> };
      question: { id: string };
    };
    assert.equal(answered.state.stage, "data");
    assert.equal(answered.state.revision, 1);
    assert.equal(answered.state.answers.surface, "support replies");
    assert.equal(answered.question.id, "data");

    const status = (await runJson(root, [
      "eval",
      "status",
      "--profile",
      "support",
      "--repository",
      root
    ])) as {
      state: { stage: string; revision: number; answers: Record<string, string> };
      question: { id: string };
    };
    assert.equal(status.state.stage, "data");
    assert.equal(status.state.revision, 1);
    assert.equal(status.state.answers.surface, "support replies");
    assert.equal(status.question.id, "data");

    const resumed = (await runJson(root, ["eval", "prepare", ...common])) as {
      state: { stage: string; revision: number; answers: Record<string, string> };
      question: { id: string };
    };
    assert.equal(resumed.state.stage, "data");
    assert.equal(resumed.state.revision, 1);
    assert.equal(resumed.state.answers.surface, "support replies");
    assert.equal(resumed.question.id, "data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
