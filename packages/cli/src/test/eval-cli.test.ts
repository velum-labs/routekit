import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  commandChildren,
  commandOptions,
  immutableCliRuntime
} from "@velum-labs/routekit-cli-core";
import { EVAL_POLICY } from "@velum-labs/routekit-eval-contracts";
import { Effect } from "effect";

import { buildProgram } from "../cli.js";
import { child, runProgram } from "./effect-cli-test.js";
import { evalSessionGatewayUrl } from "../effect/eval-authoring-target.js";
import { policyShowCommand } from "../effect/eval-cli.js";

const command = (name: string) => {
  return child(buildProgram(), name);
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
  await runProgram(buildProgram(runtimeFor(root, stdout)), ["--json", ...args]);
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
    commandChildren(evalCommand).map((entry) => entry.name),
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

  const propose = child(evalCommand, "propose");
  const approve = child(evalCommand, "approve");
  assert.deepEqual(
    commandChildren(propose).map((entry) => entry.name),
    ["dimensions", "evaluations"]
  );
  assert.deepEqual(
    commandChildren(approve).map((entry) => entry.name),
    ["dimensions", "evaluations"]
  );

  assert.equal(commandChildren(evalCommand).some((entry) => ["prepare", "show"].includes(entry.name)), false);
  assert.doesNotMatch(evalCommand.description ?? "", /profile/u);
});

test("eval workflow defaults to repository state and configured RouteKit targets", () => {
  const evalCommand = command("eval");
  const subcommand = (name: string) => child(evalCommand, name);
  const optionNames = (name: string) => commandOptions(subcommand(name)).map((option) => option.name);

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
    assert.ok(optionNames(name).includes("repository"));
  }
  assert.ok(optionNames("answer").includes("answer-file"));
  assert.ok(optionNames("estimate").includes("scope"));
  assert.ok(optionNames("run").includes("plan"));
  assert.ok(optionNames("run").includes("gateway-url"));
  assert.ok(optionNames("run").includes("token-file"));
  assert.equal(optionNames("run").includes("url"), false);
  assert.equal(optionNames("run").includes("token"), false);

  const propose = subcommand("propose");
  for (const name of ["dimensions", "evaluations"]) {
    const authored = child(propose, name);
    assert.match(authored.description ?? "", /configured RouteKit target/u);
    assert.ok(commandOptions(authored).some((option) => option.name === "file"));
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
