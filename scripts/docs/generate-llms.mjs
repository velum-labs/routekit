import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(root, "apps/docs/content/docs");
const output = path.join(root, "apps/docs/public/llms.txt");
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

function markdownRoute(route) {
  return `${route}.md`;
}

const sectionDefinitions = [
  {
    title: "Agent entry points",
    routes: [
      "/docs/getting-started/agent-guide",
      "/docs",
      "/docs/getting-started/quickstart",
      "/docs/getting-started/installation",
      "/docs/guides/user-guide"
    ]
  },
  {
    title: "Configure routes",
    routes: [
      "/docs/reference/configuration",
      "/docs/guides/aws-bedrock",
      "/docs/reference/model-catalog"
    ]
  },
  {
    title: "Connect coding tools and APIs",
    routes: [
      "/docs/guides/coding-tools",
      "/docs/guides/http-gateway",
      "/docs/reference/client-compatibility"
    ]
  },
  {
    title: "Pool subscriptions",
    routes: ["/docs/guides/subscription-pooling", "/docs/concepts/subscription-routing"]
  },
  {
    title: "Operate and recover",
    routes: [
      "/docs/guides/operations",
      "/docs/guides/remote-gateway",
      "/docs/guides/troubleshooting"
    ]
  },
  {
    title: "Understand and verify",
    routes: [
      "/docs/concepts/architecture",
      "/docs/concepts/privacy",
      "/docs/reference/commands",
      "/docs/reference/packages",
      "/docs/reference/api"
    ]
  },
  {
    title: "Develop and review history",
    routes: ["/docs/guides/source-development", "/docs/changelog"]
  }
];

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
const pageByRoute = new Map(pages.map((page) => [page.route, page]));
const assigned = new Set();
const sections = sectionDefinitions.map((section) => ({
  title: section.title,
  pages: section.routes.flatMap((route) => {
    const page = pageByRoute.get(route);
    if (page === undefined) return [];
    assigned.add(route);
    return [page];
  })
}));
const additional = pages.filter((page) => !assigned.has(page.route));
if (additional.length > 0) sections.push({ title: "Additional documentation", pages: additional });

function pageLine(page) {
  return `- [${page.title}](${markdownRoute(page.route)}): ${page.description}`;
}

const lines = [
  "# RouteKit documentation",
  "",
  "> RouteKit is an open-source CLI and authenticated model gateway for coding tools, API providers, and subscription pools.",
  "",
  "These documents describe the current product behavior on `main`, including changes scheduled for the next package release. Version numbers in changelogs and evidence reports are historical records, not alternate operating instructions.",
  "",
  "## Machine-readable resources",
  "",
  "- [Agent guide](/docs/getting-started/agent-guide.md): Compact operating rules, safe command selection, verification, and recovery.",
  "- [Command manifest](/agent/commands.json): Current CLI syntax plus automation and safety metadata.",
  "- [Error manifest](/agent/errors.json): Structured CLI and control error meanings and remediation.",
  "- [Full documentation corpus](/llms-full.txt): All processed documentation in one text response.",
  "",
  "## Source and precedence",
  "",
  "- [Source repository](https://github.com/velum-labs/routekit): Product and documentation source of truth.",
  "- [Supported coding tool versions](/docs/reference/client-compatibility.md): Authoritative supported coding-tool builds.",
  "- [CLI command reference](/docs/reference/commands.md): Human-readable CLI reference; use the command manifest for structured lookup.",
  "",
  ...sections.flatMap((section) => [`## ${section.title}`, "", ...section.pages.map(pageLine), ""]),
  "## Safety boundary",
  "",
  "Do not infer unlimited use. Provider terms, subscription eligibility, quotas, and billing apply. A namespaced model selects its configured route; subscription pools rotate only within the same subscription kind and never fall back to paid API-key providers.",
  ""
];
await writeFile(output, `${lines.join("\n")}`);
console.log(`Generated ${path.relative(root, output)} with ${pages.length} routes.`);
