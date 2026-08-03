import { existsSync, readdirSync, readFileSync } from "node:fs";

const changesetDir = ".changeset";
const vagueSummary = /^\s*[-*]\s+(?:improvements?|misc(?:ellaneous)? changes?)\s*$/i;
let failed = false;

for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith(".md") || file === "README.md") continue;
  const source = readFileSync(`${changesetDir}/${file}`, "utf8");
  const separator = source.indexOf("---", 3);
  const body = separator === -1 ? "" : source.slice(separator + 3).trim();
  if (body.length === 0) {
    console.error(`changelog quality: ${changesetDir}/${file} has no release summary`);
    failed = true;
    continue;
  }
  if (body.split("\n").some((line) => vagueSummary.test(line))) {
    console.error(`changelog quality: ${changesetDir}/${file} uses a vague summary`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log("changelog quality check passed");
