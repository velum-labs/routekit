import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("onboarding skill is RouteKit-branded and preserves approval boundaries", async () => {
  const skill = await readFile(
    path.join(packageRoot, "skills", "setup-eval-routing", "SKILL.md"),
    "utf8"
  );
  assert.match(skill, /setup-eval-routing/u);
  assert.match(skill, /one question per turn/iu);
  assert.match(skill, /Never spend or publish silently/u);
  assert.match(skill, /thin façade/u);
  assert.doesNotMatch(skill, /OPENROUTER_API_KEY/u);
});
