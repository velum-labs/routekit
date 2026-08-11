import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const requirement = packageJson.engines?.node;
const match = typeof requirement === "string" ? /^>=([0-9]+\.[0-9]+\.[0-9]+)$/.exec(requirement) : null;
if (match?.[1] === undefined) throw new Error("package.json engines.node must be an exact >=x.y.z requirement");

const expected = match[1];
const files = [
  new URL("../README.md", import.meta.url),
  new URL("../apps/docs/content/docs/guides/source-development.mdx", import.meta.url)
];
for (const file of files) {
  const content = readFileSync(file, "utf8").replace(/\s+/g, " ");
  if (!content.includes(`Node.js ${expected} or newer`) && !content.includes(`Node.js ${expected} or later`)) {
    throw new Error(`${file.pathname} does not document Node.js ${expected}`);
  }
}
