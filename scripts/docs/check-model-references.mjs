import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(root, "apps/docs/content/docs");
const catalog = JSON.parse(
  await readFile(path.join(root, "spec/registry/model-catalog.json"), "utf8")
);
const current = new Set();
for (const [provider, models] of Object.entries(catalog.modelCatalog.curated)) {
  for (const model of models) current.add(`${provider}/${model}`);
}
const historicalFile = "reference/routes-and-billing.mdx";
const canonicalSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isCanonicalDocument(name) {
  if (!name.endsWith(".mdx")) return false;
  return canonicalSegment.test(name.slice(0, -".mdx".length));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && canonicalSegment.test(entry.name)) {
      files.push(...(await walk(target)));
    } else if (entry.isFile() && isCanonicalDocument(entry.name)) {
      files.push(target);
    }
  }
  return files;
}

const errors = [];
for (const file of await walk(docsRoot)) {
  const relative = path.relative(docsRoot, file).replaceAll(path.sep, "/");
  if (relative === historicalFile) continue;
  const markdown = await readFile(file, "utf8");
  const references = markdown.matchAll(
    /(?<!@)\b(openai|anthropic|openrouter|google|codex|claude-code)\/([a-zA-Z0-9._/-]+)/g
  );
  for (const match of references) {
    const candidate = match[0].replace(/[.,;:)]+$/, "");
    if (
      candidate.endsWith("/") ||
      candidate.endsWith("-") ||
      candidate.startsWith("codex/models") ||
      candidate.startsWith("codex/responses")
    ) {
      continue;
    }
    if (!current.has(candidate)) errors.push(`${relative}: ${candidate}`);
  }
}
if (errors.length) throw new Error(`Outdated public model references:\n${errors.join("\n")}`);
console.log(`Validated public model references against ${current.size} current catalog entries.`);
