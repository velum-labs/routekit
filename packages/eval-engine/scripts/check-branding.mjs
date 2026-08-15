import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowed = new Set([
  "LICENSE",
  "NOTICE",
  "UPSTREAM_PROVENANCE.json",
  "scripts/check-branding.mjs",
  "scripts/generate-vendor-manifest.mjs"
]);
const patterns = [/\bori\b/iu, /@ori/iu, /openrouter/iu, /ori[-_/]/iu];
const failures = [];
for await (const path of glob(["**/*"], { cwd: root, exclude: ["dist/**", "node_modules/**"] })) {
  if (allowed.has(path)) continue;
  let text;
  try {
    text = await readFile(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line)))
      failures.push(`${path}:${index + 1}:${line.trim()}`);
  });
}
if (failures.length > 0)
  throw new Error(
    `upstream branding found outside legal/provenance allowlist:\n${failures.join("\n")}`
  );
console.log("RouteKit Eval branding verified");
