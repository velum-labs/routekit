#!/usr/bin/env node
/**
 * Fail if Bun APIs remain under src/, scripts/, test/, or skills/.
 *
 * Wave 0 commits the current hit list as an allowlist. Wave 3 requires the
 * allowlist to be empty.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const SCAN_ROOTS = ["src", "scripts", "test", "skills"] as const;
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".build",
]);
const SKIP_FILES = new Set(["scripts/verify-no-bun.ts"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".json"]);

const PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "Bun.", regex: /\bBun\./u },
  { name: "Bun?", regex: /\bBun\?/u },
  { name: 'from "bun:', regex: /from\s+["']bun:/u },
  { name: "@effect/platform-bun", regex: /@effect\/platform-bun/u },
  { name: "#!/usr/bin/env bun", regex: /#!\/usr\/bin\/env bun/u },
  { name: "bun:test", regex: /bun:test/u },
  { name: "bun:sqlite", regex: /bun:sqlite/u },
  { name: "BUN_BE_BUN", regex: /BUN_BE_BUN/u },
  { name: "ensureBun", regex: /\bensureBun\b/u },
  { name: 'spawn "bun"', regex: /(?:make|spawn)\(\s*["']bun["']/u },
  {
    name: 'runBufferedCommand bun',
    regex: /runBufferedCommand\([\s\S]{0,120}["']bun["']/u,
  },
];

/**
 * Relative paths (from package root) still allowed to mention Bun.
 * Wave 3 must empty this list.
 */
const ALLOWLIST = new Set<string>([]);

const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      files.push(...(await walk(full)));
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
};

const hitsIn = (source: string): readonly string[] =>
  PATTERNS.filter((pattern) => pattern.regex.test(source)).map((pattern) => pattern.name);

const relative = (absolute: string): string =>
  path.relative(packageRoot, absolute).split(path.sep).join("/");

const files: string[] = [];
for (const root of SCAN_ROOTS) {
  files.push(...(await walk(path.join(packageRoot, root))));
}

const unexpected: string[] = [];
const remainingAllowlist: string[] = [];
const staleAllowlist: string[] = [];
const seenAllowlisted = new Set<string>();

for (const file of files) {
  const rel = relative(file);
  if (SKIP_FILES.has(rel)) {
    continue;
  }
  const source = await readFile(file, "utf8");
  const hits = hitsIn(source);
  if (hits.length === 0) {
    continue;
  }
  if (ALLOWLIST.has(rel)) {
    remainingAllowlist.push(`${rel} (${hits.join(", ")})`);
    seenAllowlisted.add(rel);
    continue;
  }
  unexpected.push(`${rel}: ${hits.join(", ")}`);
}

for (const allowed of ALLOWLIST) {
  if (allowed === "scripts/verify-no-bun.ts") {
    continue;
  }
  if (!seenAllowlisted.has(allowed)) {
    staleAllowlist.push(allowed);
  }
}

console.log(`allowlisted remaining: ${remainingAllowlist.length}`);
for (const line of remainingAllowlist.sort()) {
  console.log(`  ${line}`);
}

if (staleAllowlist.length > 0) {
  console.log(`stale allowlist entries (no longer hit): ${staleAllowlist.length}`);
  for (const line of staleAllowlist.sort()) {
    console.log(`  ${line}`);
  }
}

if (unexpected.length > 0) {
  console.error(`unexpected Bun hits: ${unexpected.length}`);
  for (const line of unexpected.sort()) {
    console.error(`  ${line}`);
  }
  process.exitCode = 1;
}

if (process.argv.includes("--require-empty") && remainingAllowlist.length > 0) {
  console.error("verify-no-bun --require-empty: allowlist is not empty");
  process.exitCode = 1;
}
