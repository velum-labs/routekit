import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { scaffoldEvalRoutingProfile } from "../scaffold.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("scaffolding writes transparent RouteKit eval and routing profile artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-scaffold-"));
  roots.push(root);
  const result = await Effect.runPromise(
    scaffoldEvalRoutingProfile({
      profileId: "support",
      repositoryRoot: root,
      surface: "support replies",
      dataSource: "test/fixtures/support.json",
      criteria: "The answer follows the support policy.",
      constraint: "lowest cost after quality",
      candidates: ["openai/cheap", "anthropic/strong"],
      judgeModel: "openai/judge",
      objective: "lowest-cost"
    }).pipe(Effect.provide(NodeServicesLayer))
  );
  const evalText = await readFile(result.evalPath, "utf8");
  const profileText = await readFile(result.profilePath, "utf8");
  assert.match(evalText, /from "routekit\/eval"/u);
  assert.doesNotMatch(evalText, /ori\/eval|OPENROUTER_API_KEY/u);
  assert.match(profileText, /openai\/cheap/u);
  assert.match(profileText, /judge: "openai\/judge"/u);
  assert.equal(result.profile.suite, ".routekit/evals/support/support.eval.ts");
});
