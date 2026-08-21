import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoot = path.join(packageRoot, "skills", "routekit");

test("RouteKit skill unifies onboarding, configuration, and eval routing", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^name: routekit$/mu);
  assert.match(skill, /Install, onboard, configure, operate, troubleshoot, and evaluate/u);
  assert.match(skill, /references\/onboarding\.md/u);
  assert.match(skill, /references\/configuration\.md/u);
  assert.match(skill, /references\/eval-routing\.md/u);
  assert.match(skill, /references\/recovery-and-safety\.md/u);
  assert.match(skill, /public `routekit` CLI/u);
  assert.match(skill, /Resolve workflow parameters/u);
  for (const parameter of [
    "routekitArgv",
    "repositoryRoot",
    "targetArgs",
    "interaction",
    "modelId",
    "evalScope"
  ]) {
    assert.match(skill, new RegExp(`\\b${parameter}\\b`, "u"));
  }
  assert.match(skill, /per-workflow parameter ledger/u);
  assert.match(skill, /\[\.\.\.routekitArgv, \.\.\.targetArgs, \.\.\.operationArgs\]/u);
  assert.match(skill, /working directory to `repositoryRoot`/u);
  assert.match(skill, /typed argv value/u);
  assert.match(skill, /Never execute a displayed template/u);
  assert.match(skill, /Ask one question per turn/u);
  assert.doesNotMatch(skill, /OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY/u);
});

test("RouteKit eval reference preserves approval and activation boundaries", async () => {
  const skill = await readFile(path.join(skillRoot, "references", "eval-routing.md"), "utf8");
  assert.match(skill, /one question per turn/iu);
  assert.match(skill, /Never spend or publish silently/u);
  assert.match(skill, /public `routekit eval` CLI/u);
  assert.match(skill, /\$ROUTEKIT eval --help/u);
  assert.match(skill, /Resolve eval parameters/u);
  for (const parameter of [
    "repositoryRoot",
    "targetArgs",
    "candidateModels",
    "planId",
    "runId",
    "spendApproved",
    "publishApproved"
  ]) {
    assert.match(skill, new RegExp(`\\b${parameter}\\b`, "u"));
  }
  assert.match(skill, /ordered,\s+deduplicated argv list/u);
  assert.match(skill, /Treat `planId` and `runId` as opaque strings/u);
  assert.match(skill, /approvals as false unless the user explicitly grants/u);
  for (const command of ["setup", "status", "answer", "validate", "estimate", "run", "publish"]) {
    assert.match(skill, new RegExp(`eval ${command}`, "u"));
  }
  for (const term of [
    "routing basis",
    "workload dimension",
    "request decomposition",
    "evidence matrix",
    "routing activation"
  ]) {
    assert.match(skill, new RegExp(term, "iu"));
  }
  assert.match(skill, /exclusive in-scope request or a distinct near-miss/iu);
  assert.match(skill, /product-behavior axes are mixed with repository-change\/process axes/iu);
  assert.match(skill, /high weight on almost every ticket/iu);
  assert.match(skill, /Unknown weight absorbs the remainder/u);
  assert.doesNotMatch(skill, /\beval prepare\b/u);
  assert.doesNotMatch(skill, /\barea catalog\b/iu);
  assert.doesNotMatch(skill, /Use RouteKit's `EvalSetup` operations/u);
  assert.doesNotMatch(skill, /test:e2e:eval-routing/u);
  assert.doesNotMatch(skill, /OPENROUTER_API_KEY/u);
});
