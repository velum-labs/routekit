import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(root, "packages/cli/CHANGELOG.md");
const outputPath = path.join(root, "apps/docs/content/docs/changelog.mdx");
const check = process.argv.includes("--check");

const source = await readFile(sourcePath, "utf8");
const packageHistory = source.replace(/^# @velum-labs\/routekit\s+/, "").trimEnd();
const recentHistory = packageHistory
  .split(/(?=^## )/m)
  .filter(Boolean)
  .slice(0, 5)
  .join("")
  .trimEnd();
const supportNote = source.match(
  /- The retained internal Google[\s\S]*?not L06-qualified\./
)?.[0];
if (!supportNote) throw new Error("Canonical CLI changelog is missing the public support note.");
const generated = `---
title: "Changelog"
description: "Recent RouteKit CLI releases generated from canonical package history."
generated: true
---

# Changelog

<Callout type="info" title="Generated release history">
  This page is generated from the canonical CLI changelog. Edit
  \`packages/cli/CHANGELOG.md\`, then run \`pnpm docs:generate-public-changelog\`.
</Callout>

Upgrade the CLI and then roll an already-running local daemon to the installed
version:

\`\`\`sh
routekit self-update
routekit daemon upgrade
\`\`\`

${recentHistory}

## Support-contract note

${supportNote}
`;

if (check) {
  const current = await readFile(outputPath, "utf8");
  if (current !== generated) {
    throw new Error(
      "Public changelog is stale. Run `pnpm docs:generate-public-changelog` and commit the result."
    );
  }
  console.log("Public changelog matches packages/cli/CHANGELOG.md.");
} else {
  await writeFile(outputPath, generated);
  console.log(`Generated ${path.relative(root, outputPath)} from packages/cli/CHANGELOG.md.`);
}
