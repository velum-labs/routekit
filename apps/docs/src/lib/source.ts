import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource()
});

export type DocsPage = (typeof source)["$inferPage"];

/**
 * Resolves the Open Graph image route for a documentation page.
 *
 * The trailing `image.png` segment keeps the docs index reachable: its slugs are
 * empty, and a required catch-all route needs at least one segment to match.
 */
export function getPageImageUrl(page: DocsPage): { segments: string[]; url: string } {
  const segments = [...page.slugs, "image.png"];
  return { segments, url: `/${["og", "docs", ...segments].join("/")}` };
}
