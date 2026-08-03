import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

const docsFrontmatter = frontmatterSchema.extend({
  sourcePath: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  editPath: z.string().optional(),
  editUrl: z.string().url().optional(),
  generated: z.boolean().optional()
});

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // A public document filename must be canonical kebab-case. This keeps
    // local drafts and OS-created duplicate files out of the built site.
    files: ["{,**/}+([a-z0-9-]).mdx"],
    schema: docsFrontmatter,
    // Keeps the compiled Markdown available for the language-model routes.
    postprocess: { includeProcessedMarkdown: true }
  },
  meta: { files: ["{,**/}meta.json"] }
});

export default defineConfig();
