import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { immutableCliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { EVAL_ATTRIBUTION_HEADER } from "@velum-labs/routekit-eval-contracts";
import { EvalService, makeRouteKitEvalServiceLayer } from "@velum-labs/routekit-eval-service";
import type { EvalExecutionPlan } from "@velum-labs/routekit-eval-setup";
import { Effect, Redacted, Ref } from "effect";
import { HttpClient } from "effect/unstable/http";

import { CliSession, runCliEffect, runWithCliSession } from "../cli-session.js";
import {
  makeQualificationCleanupRef,
  qualificationGatewayCallObserver,
  withQualificationTarget
} from "../effect/eval-execution-target.js";
import { removeStaleQualificationSdkLinks } from "../effect/eval-cli.js";
import { setTargetSelection } from "../target.js";

const candidateModels = [
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "bedrock/global.anthropic.claude-fable-5",
  "bedrock/global.anthropic.claude-sonnet-5",
  "bedrock/global.anthropic.claude-opus-5",
  "bedrock/openai.gpt-5.6-sol",
  "bedrock/openai.gpt-5.6-terra",
  "bedrock/openai.gpt-5.6-luna",
  "codex/gpt-5.6-sol",
  "codex/gpt-5.6-terra",
  "codex/gpt-5.6-luna",
  "claude-code/claude-opus-5",
  "claude-code/claude-sonnet-5",
  "claude-code/claude-fable-5"
] as const;
const classifierModel = "openai/gpt-5.6-luna";
const judgeModel = "bedrock/openai.gpt-5.6-sol";
const allowedModels = [...new Set([classifierModel, judgeModel, ...candidateModels])];

const plan: EvalExecutionPlan = {
  version: 1,
  planId: "plan-live-remote",
  projectId: "project-live-remote",
  projectRevision: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  scope: "full",
  basisDigest: "basis",
  evaluationDigest: "evaluation",
  candidateModels,
  classifierModel,
  authorModel: "openai/author",
  judgeModel,
  selectedCaseIds: [{ dimensionId: "provider-protocol-translation", caseIds: ["case-1"] }],
  selectedDecompositionCaseIds: [],
  selectedCompositionCaseIds: [],
  maximumOutputTokens: 1_024,
  expectedDimensionCandidateCalls: candidateModels.length,
  expectedDimensionJudgeCalls: candidateModels.length,
  expectedClassifierCalls: 0,
  expectedCompositionCandidateCalls: 0,
  expectedCompositionJudgeCalls: 0,
  expectedCandidateCalls: candidateModels.length,
  expectedJudgeCalls: candidateModels.length,
  expectedCallCount: candidateModels.length * 2
};

test("published CLI qualification observes child gateway-bridge calls after remote session open", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-remote-target-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const transcript = join(root, "control.jsonl");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "routekit-checkout", private: true })}\n`
  );
  const suiteRoot = join(
    root,
    ".routekit",
    "evals",
    "plans",
    plan.planId,
    "dimensions",
    "provider-protocol-translation"
  );
  mkdirSync(join(suiteRoot, "data"), { recursive: true });
  const suitePath = join(suiteRoot, "provider-protocol-translation.eval.ts");
  writeFileSync(
    suitePath,
    [
      'import { test } from "node:test";',
      'import { setupAgent, setupJudge } from "routekit/eval";',
      'import cases from "./data/cases.json" with { type: "json" };',
      'import manifest from "./routekit.eval-manifest.json" with { type: "json" };',
      "const judge = setupJudge({ agent: setupAgent({ model: manifest.judgeModel }) });",
      "for (const model of manifest.candidateModels) {",
      "  for (const testCase of cases) {",
      "    test(`${model} / ${testCase.id}`, async () => {",
      "      const run = await setupAgent({ model }).run({",
      "        prompt: testCase.prompt,",
      "        caseId: testCase.id",
      "      });",
      "      run.toComplete();",
      "      await judge.autoEvals({",
      "        criteria: testCase.rubric,",
      "        prompt: testCase.prompt,",
      "        run",
      "      });",
      "    });",
      "  }",
      "}"
    ].join("\n")
  );
  writeFileSync(
    join(suiteRoot, "data", "cases.json"),
    `${JSON.stringify([{ id: "case-1", prompt: "Help", rubric: "Helpful" }])}\n`
  );
  writeFileSync(
    join(suiteRoot, "routekit.eval-manifest.json"),
    `${JSON.stringify({
      version: 1,
      profileId: "provider-protocol-translation",
      candidateModels,
      judgeModel,
      caseCount: 1,
      caseIds: ["case-1"],
      maxOutputTokens: 1_024,
      expectedCallCount: candidateModels.length * 2
    })}\n`
  );
  mkdirSync(join(suiteRoot, "node_modules"), { recursive: true });
  symlinkSync(
    join(root, "removed-published-cli-sdk", "routekit"),
    join(suiteRoot, "node_modules", "routekit")
  );
  symlinkSync(
    join(root, "removed-published-cli-sdk", "ori"),
    join(suiteRoot, "node_modules", "ori")
  );

  const gatewayRequests: Array<{ authorization?: string; attribution?: string }> = [];
  const gateway = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly model: string;
      };
      gatewayRequests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        ...(request.headers[EVAL_ATTRIBUTION_HEADER] === undefined
          ? {}
          : { attribution: String(request.headers[EVAL_ATTRIBUTION_HEADER]) })
      });
      const content =
        body.model === judgeModel
          ? JSON.stringify({ pass: true, reason: "helpful", score: 0.9 })
          : "Helpful answer";
      response.writeHead(200, {
        "content-type": "application/json",
        "x-routekit-model-call-id": `model_call_live_remote_${String(gatewayRequests.length)}`
      });
      response.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: "assistant", content } }]
        })
      );
    })();
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address() as AddressInfo;
  const gatewayUrl = `http://127.0.0.1:${String(address.port)}`;

  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const envelope = JSON.parse(input);",
      "  const request = envelope.request;",
      `  appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ method: request.method, params: request.params }) + '\\n');`,
      "  let result;",
      "  if (request.method === 'models.list') {",
      `    result = { models: ${JSON.stringify(allowedModels.map((id) => ({ id })))}, revision: 1 };`,
      "  } else if (request.method === 'evalSession.open') {",
      `    result = { sessionId: 'eval-live', gatewayUrl: ${JSON.stringify(gatewayUrl)}, bearerCredential: 'eval-secret', targetIdentity: 'routekit-generation:1', expiresAt: '2026-08-20T02:00:00.000Z' };`,
      "  } else if (request.method === 'evalSession.close') {",
      "    result = { sessionId: request.params.sessionId, closed: true };",
      "  } else {",
      "    process.stderr.write('unexpected control method ' + request.method + '\\n');",
      "    process.exit(1);",
      "  }",
      "  process.stdout.write(JSON.stringify({",
      "    status: 200,",
      "    body: { protocol: request.protocol, id: request.id, ok: true, result }",
      "  }) + '\\n');",
      "});"
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(ssh, 0o700);

  const previousHome = process.env.ROUTEKIT_HOME;
  const previousPath = process.env.PATH;
  process.env.ROUTEKIT_HOME = home;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const session = new CliSession(immutableCliRuntime(processCliRuntime));

  try {
    session.remotes.registry.put({
      name: "orbit",
      gatewayUrl,
      sshHost: "orbit.test",
      addedAt: "2026-08-20T00:00:00.000Z",
      tokenId: "orbit-token"
    });
    await session.remotes.credentials.write("orbit", "gateway-token");
    setTargetSelection({ local: false, remote: "orbit" }, session);

    const result = await runWithCliSession(session, () =>
      runCliEffect(
        Effect.gen(function* () {
          const cleanup = yield* makeQualificationCleanupRef;
          const observed = yield* Ref.make<
            readonly { readonly callId?: string; readonly role: "candidate" | "judge" }[]
          >([]);
          const httpClient = yield* HttpClient.HttpClient;
          const observeGatewayCall = qualificationGatewayCallObserver(observed);
          const comparison = yield* withQualificationTarget(
            { operationId: "eval-run-live-remote", plan },
            cleanup,
            (target) =>
              Effect.gen(function* () {
                yield* removeStaleQualificationSdkLinks(suitePath);
                const service = yield* EvalService;
                return yield* service.runComparison(
                  {
                    version: 1,
                    profileId: "provider-protocol-translation",
                    suitePath,
                    candidateModels,
                    judgeModel,
                    gatewayUrl: target.gatewayUrl,
                    timeoutMs: 15_000
                  },
                  "full"
                );
              }).pipe(
                Effect.provide(
                  makeRouteKitEvalServiceLayer(
                    {},
                    {
                      bearerCredential: Redacted.value(target.bearerCredential),
                      isolateExecutionFromProjectSdk: true,
                      observeGatewayCall,
                      timeoutMs: 15_000
                    }
                  )
                ),
                Effect.provideService(HttpClient.HttpClient, httpClient)
              )
          );
          return {
            comparison,
            cleanup: yield* Ref.get(cleanup),
            observed: yield* Ref.get(observed)
          };
        })
      )
    );

    const controlCalls = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: { allowedModels?: readonly string[] };
          }
      );

    assert.equal(result.comparison.models.length, candidateModels.length);
    assert.deepEqual(
      controlCalls.map(({ method }) => method),
      ["models.list", "evalSession.open", "evalSession.close"]
    );
    assert.deepEqual(controlCalls[1]?.params.allowedModels, allowedModels);
    assert.deepEqual(result.cleanup, { sessionOpened: true, sessionClosed: true });
    assert.equal(result.observed.length, candidateModels.length * 2);
    assert.deepEqual(result.observed[0], {
      callId: "model_call_live_remote_1",
      role: "candidate"
    });
    assert.equal(gatewayRequests.length, candidateModels.length * 2);
    assert.equal(gatewayRequests[0]?.authorization, "Bearer eval-secret");
    assert.match(gatewayRequests[0]?.attribution ?? "", /"role":"candidate"/u);
  } finally {
    await session.dispose();
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
