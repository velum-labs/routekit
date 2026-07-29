import { readFile } from "node:fs/promises";
import path from "node:path";
import { source } from "@/lib/source";

const DOCS_CONTENT_ROOT = path.join(process.cwd(), "content/docs");

type LLMPage = {
  path: string;
  url: string;
  data: { title?: string; description?: string };
};

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/**
 * Renders one documentation page as plain Markdown for language models.
 *
 * The published site keeps authored MDX on disk, so the raw file is the most
 * faithful representation of a page: it avoids re-serializing compiled JSX and
 * keeps component usage visible to a reader that only receives text.
 */
export async function getLLMText(page: LLMPage): Promise<string> {
  const markdown = await readFile(path.join(DOCS_CONTENT_ROOT, page.path), "utf8");
  const heading = `# ${page.data.title ?? page.url} (${page.url})`;
  const description = page.data.description ? `\n\n${page.data.description}` : "";
  return `${heading}${description}\n\n${stripFrontmatter(markdown)}\n`;
}

export async function getAllLLMText(): Promise<string> {
  const pages = source.getPages() as unknown as LLMPage[];
  const ordered = [...pages].sort((a, b) => a.url.localeCompare(b.url));
  const rendered = await Promise.all(ordered.map(getLLMText));
  return rendered.join("\n\n");
}
