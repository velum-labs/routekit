import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROUTEKIT_SCOPE = "@velum-labs/routekit";
const FORBIDDEN_PRODUCT = ["fu", "sion", "kit"].join("");
const FORBIDDEN_SCOPE = `@${FORBIDDEN_PRODUCT}/`;

function productionSources(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name === "__tests__") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
  };
  visit(join(root, "src"));
  return files;
}

test("RouteKit gateway and accounts use RouteKit workspace + catalog deps", () => {
  const foreignImport = new RegExp(FORBIDDEN_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  for (const directory of ["gateway", "accounts"]) {
    const root = join(packageRoot, directory);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith(ROUTEKIT_SCOPE)) {
        assert.equal(version, "workspace:*", `${directory} ${name}`);
        continue;
      }
      assert.equal(version, "catalog:", `${directory} ${name}`);
    }
    for (const path of productionSources(root)) {
      assert.doesNotMatch(readFileSync(path, "utf8"), foreignImport, path);
    }
  }
});
