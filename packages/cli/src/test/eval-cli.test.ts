import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { immutableCliRuntime } from "@velum-labs/routekit-cli-core";
import { EVAL_POLICY } from "@velum-labs/routekit-eval-contracts";
import { Effect } from "effect";

import { buildProgram } from "../cli.js";
import { evalSessionGatewayUrl } from "../effect/eval-authoring-target.js";
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

test("eval authoring uses the selected remote data URL with the remote session credential", () => {
  assert.equal(
    evalSessionGatewayUrl("http://127.0.0.1:8080", "https://shared.example.test"),
    "https://shared.example.test"
  );
  assert.equal(evalSessionGatewayUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("eval command tree exposes the compositional product workflow", () => {
  const evalCommand = command("eval");
  assert.deepEqual(
    evalCommand.commands.map((entry) => entry.name()),
    [
      "setup",
      "status",
      "answer",
      "propose",
      "approve",
      "validate",
      "estimate",
      "run",
      "results",
      "publish"
    ]
  );

  const propose = evalCommand.commands.find((entry) => entry.name() === "propose");
  const approve = evalCommand.commands.find((entry) => entry.name() === "approve");
  assert.deepEqual(
    propose?.commands.map((entry) => entry.name()),
    ["dimensions", "evaluations"]
  );
  assert.deepEqual(
    approve?.commands.map((entry) => entry.name()),
    ["dimensions", "evaluations"]
  );

  const help = evalCommand.helpInformation();
  assert.doesNotMatch(help, /^\s+(prepare|show)\b/mu);
  assert.doesNotMatch(help, /profile/u);
});

test("eval workflow defaults to repository state and configured RouteKit targets", () => {
  const evalCommand = command("eval");
  const subcommand = (name: string) => {
    const found = evalCommand.commands.find((entry) => entry.name() === name);
    assert.ok(found, `missing eval ${name}`);
    return found;
  };

  for (const name of [
    "setup",
    "status",
    "answer",
    "validate",
    "estimate",
    "run",
    "results",
    "publish"
  ]) {
    assert.match(subcommand(name).helpInformation(), /--repository <path>/u);
  }
  assert.match(subcommand("answer").helpInformation(), /--answer-file <path>/u);
  assert.match(subcommand("estimate").helpInformation(), /--scope <scope>/u);
  assert.match(subcommand("run").helpInformation(), /--plan <id>/u);
  assert.match(subcommand("run").helpInformation(), /--gateway-url <url>/u);
  assert.match(subcommand("run").helpInformation(), /--token-file <path>/u);
  assert.doesNotMatch(subcommand("run").helpInformation(), /--url <gateway>/u);
  assert.doesNotMatch(subcommand("run").helpInformation(), /--token <token>/u);

  const propose = subcommand("propose");
  for (const name of ["dimensions", "evaluations"]) {
    const authored = propose.commands.find((entry) => entry.name() === name);
    assert.ok(authored);
    assert.match(authored.helpInformation(), /configured RouteKit target/u);
    assert.match(authored.helpInformation(), /--file <path>/u);
  }
});

test("setup, status, and answer persist one compositional eval project", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-project-"));
  try {
    writeFileSync(
      join(root, "support.ts"),
      'client.responses.create({ model: "openai/current" });\n'
    );
    const repository = ["--repository", root] as const;

    const setup = (await runJson(root, ["eval", "setup", ...repository])) as {
      state: { projectId: string; stage: string; progress: { _tag: string } };
      question: { id: string };
      nextAction: string;
    };
    assert.equal(setup.state.stage, "setup-required");
    assert.equal(setup.state.progress._tag, "WorkloadDescriptionRequired");
    assert.equal(setup.question.id, "workload-description");
    assert.equal(setup.nextAction, "answer");

    const answered = (await runJson(root, [
      "eval",
      "answer",
      ...repository,
      "--answer",
      "Production support requests"
    ])) as {
      state: { projectId: string; progress: { _tag: string } };
      question: { id: string };
    };
    assert.equal(answered.state.projectId, setup.state.projectId);
    assert.equal(answered.state.progress._tag, "CandidateModelsRequired");
    assert.equal(answered.question.id, "candidate-models");

    const status = (await runJson(root, ["eval", "status", ...repository])) as {
      state: { projectId: string; progress: { _tag: string } };
    };
    assert.equal(status.state.projectId, setup.state.projectId);
    assert.equal(status.state.progress._tag, "CandidateModelsRequired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
