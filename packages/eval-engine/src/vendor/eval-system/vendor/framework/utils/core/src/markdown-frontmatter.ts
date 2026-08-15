import type { Document } from "yaml";

import { Effect } from "effect";
import { isMap, parseDocument } from "yaml";

interface ParsedMarkdownFrontmatter {
  readonly body: string;
  readonly diagnostics: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly hasFrontmatter: boolean;
}

/**
 * Insert or overwrite string-valued frontmatter keys on a markdown document,
 * preserving the existing frontmatter (other keys, ordering, comments) and the
 * body. When the document has no frontmatter, a fresh `---` block is synthesized
 * ahead of the body. Existing keys are replaced in place, so the operation is
 * idempotent — re-stamping with a new value simply updates that key.
 *
 * Used at scaffold time to stamp the generating CLI version into a workspace's
 * root `routekit-eval.md` without disturbing the author-authored `model`/persona body.
 */
const upsertMarkdownFrontmatter = (
  raw: string,
  fields: Readonly<Record<string, string>>
): string => {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return raw;
  }

  const normalized = raw.replaceAll("\r\n", "\n");
  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && line.trimEnd() === "---"
    );
    if (closingIndex !== -1) {
      const document = parseDocument(lines.slice(1, closingIndex).join("\n"));
      for (const [key, value] of entries) {
        document.set(key, value);
      }
      const body = lines.slice(closingIndex + 1).join("\n");
      return `---\n${document.toString()}---\n${body}`;
    }
  }

  // No (parseable) frontmatter: synthesize a block ahead of the body, dropping
  // any leading blank lines so the `---` fence sits flush at column 0.
  const document = parseDocument("");
  for (const [key, value] of entries) {
    document.set(key, value);
  }
  const body = normalized.replace(/^\n+/u, "");
  return `---\n${document.toString()}---\n\n${body}`;
};

const deleteFrontmatterKey = (
  document: Document,
  key: string | readonly string[]
): boolean => {
  if (typeof key === "string") {
    return document.delete(key);
  }
  const removed = document.deleteIn(key);
  for (let depth = key.length - 1; depth > 0; depth -= 1) {
    const parentPath = key.slice(0, depth);
    const parent: unknown = document.getIn(parentPath, true);
    if (isMap(parent) && parent.items.length === 0) {
      document.deleteIn(parentPath);
    }
  }
  return removed;
};

/**
 * Remove frontmatter keys from a markdown document, preserving the rest of
 * the frontmatter (other keys, ordering, comments) and the body. A key given
 * as a path array removes a nested key (e.g. `["metadata",
 * "gateway-skill-id"]`); a parent map emptied by nested removals is
 * dropped too. A document without frontmatter, or without any of the keys, is
 * returned unchanged.
 *
 * Used by `routekit-eval pack` to strip managed skill pointer keys after inlining the
 * resolved skill content, so packed interns never attempt a network fetch.
 */
const removeMarkdownFrontmatterKeys = (
  raw: string,
  keys: readonly (string | readonly string[])[]
): string => {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return raw;
  }
  const lines = normalized.split("\n");
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === "---"
  );
  if (closingIndex === -1) {
    return raw;
  }
  const document = parseDocument(lines.slice(1, closingIndex).join("\n"));
  let removed = false;
  for (const key of keys) {
    removed = deleteFrontmatterKey(document, key) || removed;
  }
  if (!removed) {
    return raw;
  }
  const body = lines.slice(closingIndex + 1).join("\n");
  return `---\n${document.toString()}---\n${body}`;
};

const EMPTY_FRONTMATTER: Readonly<Record<string, unknown>> = Object.freeze({});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatYamlIssue = (message: string): string =>
  `is not valid YAML: ${message}`;

/**
 * Parse the YAML block between the `---` fences. Using a real YAML parser (rather
 * than a line-by-line reader) means folded/block scalars (`>` / `|`), flow and
 * block sequences, and quoted strings all decode the way authors expect, so a
 * skill ported from another agent format validates instead of erroring on a
 * multi-line `description`. `uniqueKeys` preserves the duplicate-key diagnostic.
 */
const parseFrontmatterBlock = (
  source: string
): {
  readonly diagnostics: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
} => {
  const document = parseDocument(source, { uniqueKeys: true });
  const diagnostics = [...document.errors, ...document.warnings].map((issue) =>
    formatYamlIssue(issue.message)
  );

  if (document.errors.length > 0) {
    return {
      diagnostics,
      frontmatter: EMPTY_FRONTMATTER,
    };
  }

  const value: unknown = document.toJS();
  if (value === null || value === undefined) {
    return {
      diagnostics,
      frontmatter: EMPTY_FRONTMATTER,
    };
  }
  if (!isPlainRecord(value)) {
    return {
      diagnostics: [
        ...diagnostics,
        "frontmatter is not a mapping of keys to values",
      ],
      frontmatter: EMPTY_FRONTMATTER,
    };
  }
  return {
    diagnostics,
    frontmatter: value,
  };
};

const parseMarkdownFrontmatterSync = (
  raw: string
): ParsedMarkdownFrontmatter => {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      body: raw,
      diagnostics: [],
      frontmatter: EMPTY_FRONTMATTER,
      hasFrontmatter: false,
    } satisfies ParsedMarkdownFrontmatter;
  }

  const lines = normalized.split("\n");
  // Only a column-0 `---` (optionally with trailing whitespace) closes the block.
  // Trimming leading whitespace would match an indented `---` inside a block
  // scalar (`|` / `>`) and prematurely truncate the frontmatter.
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === "---"
  );
  if (closingIndex === -1) {
    return {
      body: "",
      diagnostics: ["has unterminated frontmatter"],
      frontmatter: EMPTY_FRONTMATTER,
      hasFrontmatter: true,
    } satisfies ParsedMarkdownFrontmatter;
  }

  const block = parseFrontmatterBlock(lines.slice(1, closingIndex).join("\n"));
  return {
    body: lines.slice(closingIndex + 1).join("\n"),
    diagnostics: block.diagnostics,
    frontmatter: block.frontmatter,
    hasFrontmatter: true,
  } satisfies ParsedMarkdownFrontmatter;
};

export const parseMarkdownFrontmatter = Effect.fn("MarkdownFrontmatter.parse")(
  (raw: string) => Effect.succeed(parseMarkdownFrontmatterSync(raw))
);

export { removeMarkdownFrontmatterKeys, upsertMarkdownFrontmatter };
export type { ParsedMarkdownFrontmatter };
