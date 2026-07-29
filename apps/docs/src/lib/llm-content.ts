import { source } from "@/lib/source";

type LLMPage = ReturnType<typeof source.getPages>[number];

/**
 * Renders one documentation page as plain Markdown for language models.
 *
 * Uses the processed Markdown produced at build time, so readers receive the
 * same resolved content the site renders rather than raw MDX component calls.
 */
export async function getLLMText(page: LLMPage): Promise<string> {
  const processed = await page.data.getText("processed");
  const description = page.data.description ? `\n\n${page.data.description}` : "";
  return `# ${page.data.title} (${page.url})${description}\n\n${processed}\n`;
}

export async function getAllLLMText(): Promise<string> {
  const ordered = [...source.getPages()].sort((a, b) => a.url.localeCompare(b.url));
  const rendered = await Promise.all(ordered.map(getLLMText));
  return rendered.join("\n\n");
}
