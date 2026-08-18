import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.match(evalText, /const candidateModels = \[/u);
  assert.match(evalText, /const candidate = setupAgent\(\{ model \}\)/u);
  assert.match(evalText, /setupAgent\(\{ model: "openai\/judge" \}\)/u);
  assert.equal((evalText.match(/"id": "/gu) ?? []).length, 3);
  assert.match(evalText, /representative-request/u);
  assert.match(evalText, /missing-context/u);
  assert.match(evalText, /constraint-boundary/u);
  assert.match(evalText, /Reference material:/u);
  assert.match(evalText, /Case-specific rubric:/u);
  assert.match(profileText, /openai\/cheap/u);
  assert.match(profileText, /judge: "openai\/judge"/u);
  assert.match(profileText, /minimumPassRate: 0\.8/u);
  assert.match(profileText, /minimumJudgeScore: 0\.8/u);
  assert.equal(result.profile.suite, ".routekit/evals/support/support.eval.ts");
});

test("scaffolding requires two unique candidates and a distinct concrete judge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-models-"));
  roots.push(root);
  const scaffold = (candidates: readonly string[], judgeModel: string) =>
    Effect.runPromise(
      scaffoldEvalRoutingProfile({
        profileId: "support",
        repositoryRoot: root,
        surface: "support replies",
        dataSource: "generated seed cases",
        criteria: "The answer is correct.",
        constraint: "lowest cost after quality",
        candidates,
        judgeModel,
        objective: "lowest-cost"
      }).pipe(Effect.provide(NodeServicesLayer))
    );
  const hasDetail =
    (pattern: RegExp) =>
    (error: unknown): boolean =>
      typeof error === "object" &&
      error !== null &&
      "detail" in error &&
      typeof error.detail === "string" &&
      pattern.test(error.detail);
  await assert.rejects(
    () => scaffold(["openai/only"], "openai/judge"),
    hasDetail(/exactly two candidate/iu)
  );
  await assert.rejects(
    () => scaffold(["openai/a", "anthropic/b"], "openai/a"),
    hasDetail(/three unique model ids/iu)
  );
  await assert.rejects(
    () => scaffold(["openai/a", "anthropic/default"], "google/judge"),
    hasDetail(/concrete provider\/model id/iu)
  );
});

test("scaffolding embeds excerpts when the data source is a repository file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-excerpts-"));
  roots.push(root);
  await writeFile(
    path.join(root, "README.md"),
    [
      "# RouteKit",
      "",
      "## Quickstart",
      "",
      "Install with npm and run routekit setup.",
      "",
      "## Why RouteKit",
      "",
      "One gateway for coding subscriptions.",
      "",
      "## Launch",
      "",
      "Run routekit codex from a project directory.",
      ""
    ].join("\n")
  );
  const result = await Effect.runPromise(
    scaffoldEvalRoutingProfile({
      profileId: "docs",
      repositoryRoot: root,
      surface: "repository-docs (README.md)",
      dataSource: "README.md (doc)",
      criteria: "Correct and complete",
      constraint: "Lowest cost",
      candidates: ["openai/cheap", "anthropic/strong"],
      judgeModel: "openai/judge",
      objective: "lowest-cost"
    }).pipe(Effect.provide(NodeServicesLayer))
  );
  const evalText = await readFile(result.evalPath, "utf8");
  assert.match(evalText, /Source: README\.md/u);
  assert.match(evalText, /## Quickstart/u);
  assert.match(evalText, /Install with npm and run routekit setup/u);
  assert.match(evalText, /readme-quickstart/u);
  assert.match(evalText, /readme-why-routekit/u);
  assert.match(evalText, /readme-launch/u);
  assert.doesNotMatch(evalText, /representative-request/u);
  assert.equal(result.profile.suite, ".routekit/evals/docs/docs.eval.ts");
});
