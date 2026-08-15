import { dirname, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { RewriteSegment, SegmentReader } from "./segments.ts";

import {
  hasImportMetaLeadingBoundary,
  isIdentifierPart,
  readBlockCommentSegment,
  readLineCommentSegment,
  readQuotedLiteralSegment,
  readRegexLiteralSegment,
} from "./segments.ts";

const readBraceSegment = (input: {
  readonly braceDepth: number;
  readonly index: number;
  readonly source: string;
  readonly stopAtClosingBrace: boolean;
}):
  | (RewriteSegment & { readonly braceDepth: number; readonly stop: false })
  | { readonly index: number; readonly stop: true }
  | undefined => {
  const char = input.source[input.index];
  if (input.stopAtClosingBrace && char === "}" && input.braceDepth === 0) {
    return {
      index: input.index + 1,
      stop: true,
    };
  }
  if (input.stopAtClosingBrace && char === "}") {
    return {
      braceDepth: input.braceDepth - 1,
      index: input.index + 1,
      stop: false,
      text: char,
    };
  }
  if (char !== "{") {
    return undefined;
  }
  return {
    braceDepth: input.stopAtClosingBrace
      ? input.braceDepth + 1
      : input.braceDepth,
    index: input.index + 1,
    stop: false,
    text: char,
  };
};

const importMetaAssetUrlExpressionPattern =
  /^new\s+URL\(\s*(["'])(?<relativePath>\.{1,2}\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)/u;

const fileUrlForSourceDirectory = (sourcePath: string): URL => {
  const sourceDirectory = dirname(sourcePath);
  const directoryPath = sourceDirectory.endsWith(sep)
    ? sourceDirectory
    : `${sourceDirectory}${sep}`;
  return pathToFileURL(directoryPath);
};

const splitUrlPathSuffix = (
  relativePath: string
): { readonly path: string; readonly suffix: string } => {
  const suffixIndex = relativePath.search(/[?#]/u);
  if (suffixIndex === -1) {
    return {
      path: relativePath,
      suffix: "",
    };
  }
  return {
    path: relativePath.slice(0, suffixIndex),
    suffix: relativePath.slice(suffixIndex),
  };
};

const matchImportMetaAssetUrlExpression = (
  source: string,
  index: number,
  sourcePath: string
): { readonly length: number; readonly replacement: string } | undefined => {
  const match = importMetaAssetUrlExpressionPattern.exec(source.slice(index));
  if (match === null) {
    return undefined;
  }
  const relativePath = match.groups?.relativePath;
  if (relativePath === undefined) {
    return undefined;
  }
  const { path: relativeAssetPath, suffix } = splitUrlPathSuffix(relativePath);
  const replacementHref = `${new URL(relativeAssetPath, fileUrlForSourceDirectory(sourcePath)).href}${suffix}`;
  return {
    length: match[0].length,
    replacement: `new URL(${JSON.stringify(replacementHref)})`,
  };
};

const readAssetUrlSegment: SegmentReader = ({ index, source, sourcePath }) => {
  const assetUrlMatch = matchImportMetaAssetUrlExpression(
    source,
    index,
    sourcePath
  );
  if (assetUrlMatch === undefined) {
    return;
  }
  return {
    index: index + assetUrlMatch.length,
    text: assetUrlMatch.replacement,
  };
};

// Four source-location aliases on `import.meta` resolve to the running
// module's own path: `dir`/`dirname` (its directory) and `path`/`filename` (the
// file itself). Every feature.ts is loaded by bundling it into a fresh
// `routekit-eval-fresh-*` temp dir, and the fresh-module bundle leaves each of these
// pointing at that bundle output — which carries only `module.mjs`, none of the
// feature's sibling files. So a runtime read derived from any of them (e.g.
// `readdir(join(import.meta.dir, "prompts"))` or `readFileSync(import.meta.path)`)
// resolves into the temp dir and throws ENOENT. Rewrite each alias to a literal of
// the corresponding source location at build time.
//
// The trailing `isIdentifierPart` guard makes each token match a whole property
// access only, never a prefix of a longer one: `import.meta.dir` cannot swallow
// the `dir` of `import.meta.dirname` (next char `n` is an identifier part), and
// likewise a hand-rolled `import.meta.pathological` is left alone. That guard makes
// the readers' relative order irrelevant for correctness; they are registered
// longest-token-first anyway so the intent reads clearly.
const importMetaLocationRewriters: readonly {
  readonly token: string;
  readonly resolve: (sourcePath: string) => string;
}[] = [
  {
    resolve: dirname,
    token: "import.meta.dirname",
  },
  {
    resolve: (sourcePath) => sourcePath,
    token: "import.meta.filename",
  },
  {
    resolve: dirname,
    token: "import.meta.dir",
  },
  {
    resolve: (sourcePath) => sourcePath,
    token: "import.meta.path",
  },
];

const importMetaLocationSegmentReaders: readonly SegmentReader[] =
  importMetaLocationRewriters.map(
    ({ resolve, token }): SegmentReader =>
      ({ index, source, sourcePath }) => {
        if (
          !source.startsWith(token, index) ||
          !hasImportMetaLeadingBoundary(source, index) ||
          isIdentifierPart(source[index + token.length] ?? "")
        ) {
          return;
        }
        return {
          index: index + token.length,
          text: JSON.stringify(resolve(sourcePath)),
        };
      }
  );

const loaderForPath = (path: string): "js" | "jsx" | "ts" | "tsx" => {
  const extension = extname(path);
  if (extension === ".jsx") {
    return "jsx";
  }
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "ts";
  }
  if (extension === ".tsx") {
    return "tsx";
  }
  return "js";
};

interface RewriteSource {
  readonly source: string;
  readonly sourcePath: string;
}

const preserveLiteralImportMetaAssetUrls = (
  source: string,
  sourcePath: string
): string =>
  // The rewrite helpers below form an irreducible recursion cycle
  // (rewriteCodeRegion -> readNextSegment -> segmentReaders -> readTemplateLiteralSegment
  // -> rewriteTemplateLiteral -> rewriteCodeRegion). Every reference is deferred to call
  // time, so the cycle is runtime-safe but cannot be linearised by reordering.
  // oxlint-disable-next-line no-use-before-define
  rewriteCodeRegion(
    {
      source,
      sourcePath,
    },
    0,
    false
  ).text;

const rewriteCodeRegion = (
  input: RewriteSource,
  start: number,
  stopAtClosingBrace: boolean
): { readonly index: number; readonly text: string } => {
  const { source, sourcePath } = input;
  let output = "";
  let index = start;
  let braceDepth = 0;
  while (index < source.length) {
    const brace = readBraceSegment({
      braceDepth,
      index,
      source,
      stopAtClosingBrace,
    });
    if (brace !== undefined) {
      if (brace.stop) {
        return {
          index: brace.index,
          text: output,
        };
      }
      ({ braceDepth } = brace);
      output += brace.text;
      ({ index } = brace);
      continue;
    }

    // oxlint-disable-next-line no-use-before-define -- irreducible rewrite recursion cycle (see preserveLiteralImportMetaAssetUrls)
    const segment = readNextSegment({
      index,
      source,
      sourcePath,
    });
    output += segment.text;
    ({ index } = segment);
  }
  return {
    index,
    text: output,
  };
};

const readNextSegment = (input: {
  readonly index: number;
  readonly source: string;
  readonly sourcePath: string;
}): RewriteSegment => {
  // oxlint-disable-next-line no-use-before-define -- irreducible rewrite recursion cycle (see preserveLiteralImportMetaAssetUrls)
  for (const reader of segmentReaders) {
    const segment = reader(input);
    if (segment !== undefined) {
      return segment;
    }
  }
  return {
    index: input.index + 1,
    text: input.source[input.index],
  };
};

const readTemplateLiteralSegment: SegmentReader = ({
  index,
  source,
  sourcePath,
}) =>
  source[index] === "`"
    ? // oxlint-disable-next-line no-use-before-define -- irreducible rewrite recursion cycle (see preserveLiteralImportMetaAssetUrls)
      rewriteTemplateLiteral(source, sourcePath, index)
    : undefined;

const rewriteTemplateLiteral = (
  source: string,
  sourcePath: string,
  start: number
): { readonly index: number; readonly text: string } => {
  let output = "`";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "\\") {
      output += source.slice(index, Math.min(index + 2, source.length));
      index += 2;
      continue;
    }
    if (char === "`") {
      return {
        index: index + 1,
        text: `${output}\``,
      };
    }
    if (char === "$" && next === "{") {
      const { index: nextIndex, text } = rewriteCodeRegion(
        {
          source,
          sourcePath,
        },
        index + 2,
        true
      );
      output += `\${${text}}`;
      index = nextIndex;
      continue;
    }
    output += char;
    index += 1;
  }
  return {
    index,
    text: output,
  };
};

const segmentReaders: readonly SegmentReader[] = [
  readAssetUrlSegment,
  ...importMetaLocationSegmentReaders,
  readQuotedLiteralSegment,
  readTemplateLiteralSegment,
  readLineCommentSegment,
  readBlockCommentSegment,
  readRegexLiteralSegment,
];

export { loaderForPath, preserveLiteralImportMetaAssetUrls };
