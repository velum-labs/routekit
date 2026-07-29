import { readFile } from "node:fs/promises";
import path from "node:path";

const BRAND_MARK_FILE = "routekit-logo-dark.png";

let brandMark: Promise<string | undefined> | undefined;

/**
 * Reads the RouteKit mark as a data URL for embedding in generated images.
 *
 * Satori cannot reach the asset server while these images are rendered, so the
 * PNG is inlined from disk. An unreadable file degrades to a type-only card
 * rather than failing the request.
 */
export function loadBrandMark(): Promise<string | undefined> {
  brandMark ??= readFile(path.join(process.cwd(), "public", BRAND_MARK_FILE))
    .then((file) => `data:image/png;base64,${file.toString("base64")}`)
    .catch(() => undefined);
  return brandMark;
}

/**
 * Names the section a page sits under, e.g. `getting-started` -> `GETTING STARTED`.
 *
 * Top-level pages have no section and fall back to the card's `DOCS` eyebrow.
 */
export function sectionLabel(slugs: string[]): string | undefined {
  if (slugs.length < 2) return undefined;
  return slugs[0].replaceAll("-", " ").toUpperCase();
}
