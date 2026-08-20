import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { immutableCliRuntime, processCliRuntime } from "@velum-labs/routekit-cli-core";
import { EVAL_ATTRIBUTION_HEADER } from "@velum-labs/routekit-eval-contracts";
import type { EvalExecutionPlan } from "@velum-labs/routekit-eval-setup";
import { Effect, Redacted, Ref } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { CliSession, runCliEffect, runWithCliSession } from "../cli-session.js";
import {
  makeQualificationCleanupRef,
  observeQualificationCalls,
  withQualificationTarget
} from "../effect/eval-execution-target.js";
import { setTargetSelection } from "../target.js";

const candidateModels = Array.from(
  { length: 15 },
  (_, index) => `openai/candidate-${String(index + 1)}`
);
const classifierModel = "openai/classifier";
const judgeModel = "openai/judge";
const allowedModels = [classifierModel, judgeModel, ...candidateModels];

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

test("selected remote qualification reaches an observed data call after one SSH catalog preflight", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-remote-target-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const transcript = join(root, "control.jsonl");
  mkdirSync(bin, { recursive: true });

  const gatewayRequests: Array<{ authorization?: string; attribution?: string }> = [];
  const gateway = createServer((request, response) => {
    gatewayRequests.push({
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
      ...(request.headers[EVAL_ATTRIBUTION_HEADER] === undefined
        ? {}
        : { attribution: String(request.headers[EVAL_ATTRIBUTION_HEADER]) })
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "x-routekit-model-call-id": "model_call_live_remote"
    });
    response.end("{}");
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
          const httpClient = observeQualificationCalls(yield* HttpClient.HttpClient, observed);
          const response = yield* withQualificationTarget(
            { operationId: "eval-run-live-remote", plan },
            cleanup,
            (target) =>
              httpClient.execute(
                HttpClientRequest.post(`${target.gatewayUrl}/v1/chat/completions`, {
                  headers: {
                    authorization: `Bearer ${Redacted.value(target.bearerCredential)}`,
                    [EVAL_ATTRIBUTION_HEADER]: JSON.stringify({
                      purpose: "eval",
                      role: "candidate",
                      runId: "run-live-remote",
                      caseId: "case-1"
                    })
                  }
                })
              )
          );
          return {
            status: response.status,
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

    assert.equal(result.status, 200);
    assert.deepEqual(
      controlCalls.map(({ method }) => method),
      ["models.list", "evalSession.open", "evalSession.close"]
    );
    assert.deepEqual(controlCalls[1]?.params.allowedModels, allowedModels);
    assert.deepEqual(result.cleanup, { sessionOpened: true, sessionClosed: true });
    assert.deepEqual(result.observed, [{ callId: "model_call_live_remote", role: "candidate" }]);
    assert.deepEqual(gatewayRequests, [
      {
        authorization: "Bearer eval-secret",
        attribution: JSON.stringify({
          purpose: "eval",
          role: "candidate",
          runId: "run-live-remote",
          caseId: "case-1"
        })
      }
    ]);
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
