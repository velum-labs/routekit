import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(root, "apps/docs/content/docs");
const output = path.join(root, "apps/docs/public/llms.txt");
const cliPackage = JSON.parse(await readFile(path.join(root, "packages/cli/package.json"), "utf8"));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.name.endsWith(".mdx")) files.push(target);
  }
  return files;
}

function metadata(markdown, key) {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const value = frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?$`, "m"))?.[1];
  return value?.replace(/["']$/, "");
}

function routeFor(file) {
  const relative = path
    .relative(docsRoot, file)
    .replaceAll(path.sep, "/")
    .replace(/\.mdx$/, "");
  return relative === "index" ? "/docs" : `/docs/${relative}`;
}

const pages = [];
for (const file of await walk(docsRoot)) {
  const markdown = await readFile(file, "utf8");
  const title = metadata(markdown, "title");
  const description = metadata(markdown, "description");
  if (!title || !description)
    throw new Error(`Missing title or description in ${path.relative(root, file)}`);
  pages.push({ route: routeFor(file), title, description });
}
pages.sort((a, b) => a.route.localeCompare(b.route));
const start = pages.filter(
  (page) =>
    page.route === "/docs" ||
    page.route.includes("/getting-started/") ||
    page.route.endsWith("/user-guide")
);
const remaining = pages.filter((page) => !start.includes(page));
const lines = [
  "# RouteKit documentation",
  "",
  "RouteKit is an open-source CLI and authenticated model gateway for coding tools, API providers, and subscription pools.",
  "",
  "Source of truth: https://github.com/velum-labs/routekit",
  "Documentation source: https://github.com/velum-labs/routekit/tree/main/apps/docs/content/docs",
  `Current documentation baseline: RouteKit ${cliPackage.version} (pre-1.0)`,
  "Authoritative mutable disclosure: /docs/reference/routes-and-billing",
  "",
  "## Start",
  ...start.map((page) => `- ${page.route} — ${page.description}`),
  "",
  "## All documentation",
  ...remaining.map((page) => `- ${page.route} — ${page.description}`),
  "",
  "Do not infer unlimited use. Provider terms, subscription eligibility, quotas, and billing apply. A namespaced model selects its configured route; subscription pools do not fall back to paid API-key providers.",
  ""
];
await writeFile(output, `${lines.join("\n")}`);
console.log(`Generated ${path.relative(root, output)} with ${pages.length} routes.`);
