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
import { EVAL_ATTRIBUTION_HEADER, EVAL_POLICY } from "@velum-labs/routekit-eval-contracts";
import { Effect, Fiber, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { buildProgram } from "../cli.js";
import {
  evalAuthoringRequestBody,
  evalAuthoringResponseFailureDetail,
  evalAuthoringResponseStatusFailureDetail,
  evalAuthoringStructuredOutput,
  evalSessionGatewayUrl
} from "../effect/eval-authoring-target.js";
import {
  DEFAULT_QUALIFICATION_TEST_TIMEOUT_MS,
  evalQualificationCliError,
  policyShowCommand,
  qualificationComparisonRequest,
  qualificationFailureDetail
} from "../effect/eval-cli.js";
import {
  includeQualificationObservedCalls,
  observeQualificationCalls,
  type QualificationObservedCall
} from "../effect/eval-execution-target.js";
import { child, runProgram } from "./effect-cli-test.js";

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

test("qualification comparisons use a provider-safe timeout instead of node:test's 120s default", () => {
  const request = qualificationComparisonRequest({
    candidateModels: ["openai/candidate"],
    dimensionId: "provider-protocol-translation",
    gatewayUrl: "https://gateway.example.test",
    judgeModel: "openai/judge",
    suitePath: "/tmp/provider-protocol-translation.eval.ts"
  });

  assert.equal(DEFAULT_QUALIFICATION_TEST_TIMEOUT_MS, 600_000);
  assert.notEqual(request.timeoutMs, 120_000);
  assert.equal(request.timeoutMs, DEFAULT_QUALIFICATION_TEST_TIMEOUT_MS);
  assert.equal(
    qualificationComparisonRequest({
      candidateModels: ["openai/candidate"],
      dimensionId: "provider-protocol-translation",
      gatewayUrl: "https://gateway.example.test",
      judgeModel: "openai/judge",
      suitePath: "/tmp/provider-protocol-translation.eval.ts",
      timeoutMs: 900_000
    }).timeoutMs,
    900_000
  );
});

test("failed qualification errors are non-zero and name dimension, timeout, and call ids", () => {
  const failure = qualificationFailureDetail({
    cause: new Error("test timed out"),
    cleanupIncomplete: false,
    comparison: {
      dimensionId: "provider-protocol-translation",
      timeoutMs: 600_000
    },
    observedCalls: [
      { callId: "model_call_candidate", role: "candidate" },
      { callId: "model_call_judge", role: "judge" }
    ]
  });
  const error = evalQualificationCliError(failure, new Error("test timed out"));

  assert.equal(error.exitCode, 1);
  assert.equal(error.code, "eval_qualification_failed");
  assert.match(error.message, /provider-protocol-translation/u);
  assert.match(error.message, /timeout 600000ms/u);
  assert.match(error.message, /model_call_candidate/u);
  assert.match(error.message, /model_call_judge/u);
  assert.match(String((error as Error & { cause?: unknown }).cause), /test timed out/u);
});

test("failed qualification ledger retains calls observed before interruption", () => {
  const ledger = includeQualificationObservedCalls(
    {
      expectedCalls: 4,
      observedCalls: 0,
      observedCandidateRows: 0,
      knownInputTokens: 0,
      knownOutputTokens: 0,
      unknownTokenMeasurements: 0,
      knownPricedSubtotalUsd: 0,
      unpricedCalls: 0
    },
    [
      {
        callId: "model_call_candidate",
        role: "candidate",
        measurement: { inputTokens: 100, outputTokens: 25, costUsd: 0.01 }
      },
      {
        callId: "model_call_judge",
        role: "judge"
      }
    ]
  );

  assert.deepEqual(ledger, {
    expectedCalls: 4,
    observedCalls: 2,
    observedCandidateRows: 1,
    knownInputTokens: 100,
    knownOutputTokens: 25,
    unknownTokenMeasurements: 1,
    knownPricedSubtotalUsd: 0.01,
    unpricedCalls: 1
  });
});

test("qualification HTTP observation captures model call ids before comparison failure", async () => {
  const observed = await Effect.runPromise(
    Effect.gen(function* () {
      const calls = yield* Ref.make<readonly QualificationObservedCall[]>([]);
      const client = observeQualificationCalls(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                {},
                { headers: { "x-routekit-model-call-id": "model_call_before_timeout" } }
              )
            )
          )
        ),
        calls
      );
      yield* client.execute(
        HttpClientRequest.post("https://gateway.example.test/v1/chat/completions", {
          headers: {
            [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
              purpose: "eval",
              role: "candidate",
              runId: "comparison-1",
              caseId: "case-1"
            })
          }
        })
      );
      return yield* Ref.get(calls);
    })
  );

  assert.deepEqual(observed, [
    { callId: "model_call_before_timeout", role: "candidate" }
  ]);
});

test("qualification HTTP observation counts a call as soon as the request is issued", async () => {
  const observed = await Effect.runPromise(
    Effect.gen(function* () {
      const calls = yield* Ref.make<readonly QualificationObservedCall[]>([]);
      const client = observeQualificationCalls(
        HttpClient.make(() => Effect.never),
        calls
      );
      const request = client.execute(
        HttpClientRequest.post("https://gateway.example.test/v1/chat/completions", {
          headers: {
            [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
              purpose: "eval",
              role: "candidate",
              runId: "comparison-1",
              caseId: "case-1"
            })
          }
        })
      );
      const fiber = yield* Effect.forkChild(request);
      yield* Effect.yieldNow;
      const issued = yield* Ref.get(calls);
      yield* Fiber.interrupt(fiber);
      return issued;
    })
  );

  assert.deepEqual(observed, [{ role: "candidate" }]);
});

test("eval authoring uses the selected remote data URL with the remote session credential", () => {
  assert.equal(
    evalSessionGatewayUrl("http://127.0.0.1:8080", "https://shared.example.test"),
    "https://shared.example.test"
  );
  assert.equal(evalSessionGatewayUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("eval authoring lets the selected model choose compatible reasoning controls", () => {
  const body = JSON.parse(
    evalAuthoringRequestBody({
      operationId: "authoring-826",
      model: "claude-code/claude-opus-5",
      instructions: "propose dimensions",
      input: "{}",
      schemaName: "routekit_routing_basis",
      jsonSchema: { type: "object" },
      maximumOutputTokens: 8_192
    })
  ) as Record<string, unknown>;
  assert.equal(body.model, "claude-code/claude-opus-5");
  assert.equal(body.max_output_tokens, 8_192);
  assert.equal(Object.hasOwn(body, "reasoning"), false);
});

test("eval authoring HTTP failures include provider diagnostics and the inspectable call id", async () => {
  const response = Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: "unsupported_reasoning_control",
        param: "reasoning.effort",
        message: 'reasoning effort "none" is not supported'
      }
    },
    {
      status: 400,
      headers: { "x-routekit-model-call-id": "model_call_eng826" }
    }
  );
  const detail = await Effect.runPromise(evalAuthoringResponseFailureDetail(response));
  assert.match(detail, /HTTP 400/u);
  assert.match(detail, /code unsupported_reasoning_control/u);
  assert.match(detail, /param reasoning\.effort/u);
  assert.match(detail, /call id model_call_eng826/u);
  assert.match(detail, /upstream body .*invalid_request_error/u);
});

test("eval authoring reports capped Responses output as incomplete, not invalid JSON", () => {
  const detail = evalAuthoringResponseStatusFailureDetail(
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: '{"cases":[{"id":"truncated'
    },
    "model_call_eng834"
  );

  assert.match(detail ?? "", /response was incomplete/u);
  assert.match(detail ?? "", /stop reason max_output_tokens/u);
  assert.match(detail ?? "", /call id model_call_eng834/u);
  assert.doesNotMatch(detail ?? "", /invalid JSON/u);
});

test("eval authoring treats an exact output-token cap as truncation", () => {
  const detail = evalAuthoringResponseStatusFailureDetail(
    {
      status: "completed",
      usage: { output_tokens: 32_768 },
      output_text: '{"cases":[{"id":"truncated'
    },
    "model_call_eng834_cap",
    32_768
  );

  assert.match(detail ?? "", /response was incomplete/u);
  assert.match(detail ?? "", /stop reason max_output_tokens/u);
  assert.match(detail ?? "", /call id model_call_eng834_cap/u);
});

test("eval authoring extracts requested JSON from common model wrappers", async () => {
  const dimensions = {
    dimensions: [
      {
        id: "gateway-protocols",
        description: "Protocol translation",
        includes: ["wire adapters"],
        excludes: ["unrelated UI"]
      }
    ]
  };
  const normalize = (text: string) =>
    Effect.runPromise(
      evalAuthoringStructuredOutput({
        operation: "authoring-dimensions",
        text,
        callId: "model_call_eng829",
        schemaName: "routekit_routing_basis",
        jsonSchema: { type: "object", required: ["dimensions"] }
      })
    );

  assert.deepEqual(
    JSON.parse(await normalize(`\`\`\`json\n${JSON.stringify(dimensions)}\n\`\`\``)),
    dimensions
  );
  assert.deepEqual(
    JSON.parse(await normalize(`Here is the requested basis:\n${JSON.stringify(dimensions)}`)),
    dimensions
  );
  assert.deepEqual(
    JSON.parse(
      await normalize(
        JSON.stringify({
          type: "function_call",
          name: "routekit_routing_basis",
          arguments: JSON.stringify(dimensions)
        })
      )
    ),
    dimensions
  );
});

test("eval authoring invalid JSON includes parse diagnostics, call id, and bounded output", async () => {
  const invalid = `${'{"dimensions":['}${"x".repeat(20_000)}`;
  const exit = await Effect.runPromiseExit(
    evalAuthoringStructuredOutput({
      operation: "authoring-dimensions",
      text: invalid,
      callId: "model_call_eng829",
      schemaName: "routekit_routing_basis",
      jsonSchema: { type: "object", required: ["dimensions"] }
    })
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure") {
    const message = String(exit.cause);
    assert.match(message, /author model returned invalid JSON/u);
    assert.match(message, /parse error/u);
    assert.match(message, /call id model_call_eng829/u);
    assert.match(message, /author output/u);
    assert.match(message, /truncated/u);
    assert.equal(message.includes("x".repeat(17_000)), false);
  }
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

  assert.equal(
    commandChildren(evalCommand).some((entry) => ["prepare", "show"].includes(entry.name)),
    false
  );
  assert.doesNotMatch(evalCommand.description ?? "", /profile/u);
});

test("eval workflow defaults to repository state and configured RouteKit targets", () => {
  const evalCommand = command("eval");
  const subcommand = (name: string) => child(evalCommand, name);
  const optionNames = (name: string) =>
    commandOptions(subcommand(name)).map((option) => option.name);

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
  assert.ok(optionNames("run").includes("timeout-ms"));
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
