import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("onboarding skill uses the public CLI and preserves approval boundaries", async () => {
  const skill = await readFile(
    path.join(packageRoot, "skills", "setup-eval-routing", "SKILL.md"),
    "utf8"
  );
  assert.match(skill, /setup-eval-routing/u);
  assert.match(skill, /one question per turn/iu);
  assert.match(skill, /Never spend or publish silently/u);
  assert.match(skill, /public `routekit eval` CLI/u);
  assert.match(skill, /\$ROUTEKIT eval --help/u);
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
  assert.doesNotMatch(skill, /\beval prepare\b/u);
  assert.doesNotMatch(skill, /\barea catalog\b/iu);
  assert.doesNotMatch(skill, /Use RouteKit's `EvalSetup` operations/u);
  assert.doesNotMatch(skill, /test:e2e:eval-routing/u);
  assert.doesNotMatch(skill, /OPENROUTER_API_KEY/u);
});
