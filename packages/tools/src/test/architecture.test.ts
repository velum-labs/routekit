import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packagesRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ROUTEKIT_SCOPE = "@velum-labs/routekit";
const FORBIDDEN_PRODUCT = ["fu", "sion", "kit"].join("");
const FORBIDDEN_SCOPE = `@${FORBIDDEN_PRODUCT}/`;
const PACKAGE_DIRS = [
  "harness-core",
  "tools",
  ...readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("tool-"))
    .map((entry) => entry.name)
];

function productionSources(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : productionSources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("neutral harness and tool packages stay within RouteKit scope", () => {
  const foreignScopePattern = new RegExp(`"${FORBIDDEN_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const foreignImportPattern = new RegExp(
    `(?:from\\s+|import\\s*\\()["']${FORBIDDEN_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
  );
  const foreignVocabulary = new RegExp(`\\b(?:${FORBIDDEN_PRODUCT}|fusion|fused)\\b`, "i");
  for (const packageDir of PACKAGE_DIRS) {
    const root = resolve(packagesRoot, packageDir);
    const manifest = readFileSync(resolve(root, "package.json"), "utf8");
    assert.doesNotMatch(manifest, foreignScopePattern, `${packageDir} manifest reaches foreign scope`);
    const tsconfig = readFileSync(resolve(root, "tsconfig.json"), "utf8");
    assert.doesNotMatch(tsconfig, /(?:ensemble|fusion-gateway|protocol|tracing|workspace)/, `${packageDir} build graph reaches product scope`);
    for (const source of productionSources(resolve(root, "src"))) {
      const content = readFileSync(source, "utf8");
      assert.doesNotMatch(content, foreignImportPattern, `${source} reaches foreign scope`);
      assert.doesNotMatch(content, foreignVocabulary, `${source} contains foreign product vocabulary`);
    }
    const parsed = JSON.parse(manifest) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries(parsed.dependencies ?? {})) {
      if (name.startsWith(ROUTEKIT_SCOPE)) {
        assert.equal(
          version,
          "workspace:*",
          `${packageDir} internal dependency ${name} must use workspace:*`
        );
        continue;
      }
      assert.equal(
        version,
        "catalog:",
        `${packageDir} third-party dependency ${name} must use catalog:`
      );
    }
  }
});
