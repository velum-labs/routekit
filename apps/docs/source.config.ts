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
  docs: { schema: docsFrontmatter }
});

export default defineConfig();
