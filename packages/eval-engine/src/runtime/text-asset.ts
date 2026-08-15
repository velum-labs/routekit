import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read a sibling markdown/text asset relative to the importing module.
 *
 * Replaces Bun/TypeScript `import … with { type: "text" }`, which Node does
 * not support.
 */
export const readTextAsset = (
  fromImportMetaUrl: string,
  relativePath: string,
): string =>
  readFileSync(
    resolve(dirname(fileURLToPath(fromImportMetaUrl)), relativePath),
    "utf8",
  );
