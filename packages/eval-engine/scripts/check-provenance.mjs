import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("ORI_PROVENANCE.json", root), "utf8"));
const destinations = manifest.files.map((entry) => entry.destination);
const sorted = destinations.toSorted((left, right) => left.localeCompare(right));

if (JSON.stringify(destinations) !== JSON.stringify(sorted)) {
  throw new Error("ORI_PROVENANCE.json files must be sorted by destination");
}

for (const entry of manifest.files) {
  const contents = await readFile(new URL(entry.destination, root));
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== entry.localSha256) {
    throw new Error(
      `${entry.destination} does not match ORI_PROVENANCE.json: expected ${entry.localSha256}, got ${actual}`
    );
  }
}

console.log(
  `Ori provenance verified (${manifest.files.length} files from ${manifest.sourceCommit})`
);
