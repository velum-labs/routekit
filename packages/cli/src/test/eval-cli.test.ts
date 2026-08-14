import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVAL_POLICY } from "@velum-labs/routekit-eval-contracts";
import { InvalidEvalRunIdError } from "@velum-labs/routekit-eval-service";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

import {
  evalDiscoverCommand,
  evalDryRunCommand,
  evalListCommand,
  evalRunCommand,
  evalShowCommand,
  policyShowCommand
} from "../effect/eval-cli.js";

const workload = {
  workloadId: "cli-workload",
  candidateModel: "openai/candidate",
  judgeModel: "openai/judge"
} as const;

test("policy show command is an Effect program with the isolation contract", async () => {
  assert.deepEqual(await Effect.runPromise(policyShowCommand), EVAL_POLICY);
});

test("eval path commands discover, list, and dry-run Ori author files", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-path-"));
  try {
    const evalFile = join(root, "cli.eval.ts");
    writeFileSync(
      evalFile,
      `
        import { test } from "node:test";
        import { setupAgent } from "ori/eval";
        const agent = setupAgent();
        test("does not run in dry-run", async () => {
          const run = await agent.run("hello");
          run.toComplete();
        });
      `
    );
    const discovery = await runRouteKitEffect(evalDiscoverCommand({ path: root }));
    assert.deepEqual(discovery.files, [evalFile]);
    assert.deepEqual(await runRouteKitEffect(evalListCommand({ path: root })), [evalFile]);
    const dryRun = await runRouteKitEffect(
      evalDryRunCommand({
        path: root,
        workload,
        storeRoot: join(root, "repository")
      })
    );
    assert.equal(dryRun.fileCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval show rejects traversal run IDs before repository access", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-traversal-"));
  try {
    await assert.rejects(
      runRouteKitEffect(evalShowCommand({ runId: "../outside", storeRoot: root })),
      (error: unknown) => error instanceof InvalidEvalRunIdError
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval run uses path/workload metadata and show reads persisted evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-eval-cli-run-"));
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "hello from candidate" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3 }
        })
      );
    });
  });
  try {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert.ok(typeof address === "object" && address !== null);
        resolve(address.port);
      });
    });
    const evalFile = join(root, "run.eval.ts");
    const storeRoot = join(root, "repository");
    writeFileSync(
      evalFile,
      `
        import { test } from "node:test";
        import { setupAgent } from "ori/eval";
        test("runs", async () => {
          const run = await setupAgent().run("hello", { caseId: "hello" });
          run.toMention("candidate");
        });
      `
    );
    const result = await runRouteKitEffect(
      evalRunCommand({
        path: evalFile,
        workload,
        gatewayUrl: `http://127.0.0.1:${port}`,
        gatewayToken: "test-token",
        storeRoot
      })
    );
    assert.equal(result.manifest.workloadId, "cli-workload");
    assert.equal(result.engine.results[0]?.outcome, "passed");
    const shown = await runRouteKitEffect(
      evalShowCommand({ runId: result.manifest.runId, storeRoot })
    );
    assert.deepEqual(shown, result);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    rmSync(root, { recursive: true, force: true });
  }
});
