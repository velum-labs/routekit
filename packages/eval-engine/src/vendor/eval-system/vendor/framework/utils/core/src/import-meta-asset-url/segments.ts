interface RewriteSegment {
  readonly index: number;
  readonly text: string;
}

type SegmentReader = (input: {
  readonly index: number;
  readonly source: string;
  readonly sourcePath: string;
}) => RewriteSegment | undefined;

const isIdentifierPart = (char: string): boolean => /[$\dA-Z_a-z]/u.test(char);

const hasImportMetaLeadingBoundary = (
  source: string,
  index: number
): boolean => {
  if (index === 0) {
    return true;
  }
  const previous = source[index - 1];
  return previous !== "." && !isIdentifierPart(previous);
};

const skipQuotedLiteral = (
  source: string,
  start: number,
  quote: string
): number => {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (char === quote) {
      return index;
    }
  }
  return source.length;
};

const skipLineComment = (source: string, start: number): number => {
  const end = source.indexOf("\n", start + 2);
  return end === -1 ? source.length : end;
};

const skipBlockComment = (source: string, start: number): number => {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
};

const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const readPreviousIdentifier = (
  source: string,
  end: number
): string | undefined => {
  if (!isIdentifierPart(source[end])) {
    return undefined;
  }
  let start = end;
  while (start > 0 && isIdentifierPart(source[start - 1])) {
    start -= 1;
  }
  return source.slice(start, end + 1);
};

const shouldSkipRegexLiteral = (source: string, start: number): boolean => {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(source[index])) {
    index -= 1;
  }
  if (index < 0) {
    return true;
  }
  if ("({[=,:;!&|?+-*%^~<>".includes(source[index])) {
    return true;
  }
  const previousKeyword = readPreviousIdentifier(source, index);
  return (
    previousKeyword !== undefined &&
    REGEX_PRECEDING_KEYWORDS.has(previousKeyword)
  );
};

const skipRegexLiteral = (source: string, start: number): number => {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      index += 1;
      continue;
    }
    index += 1;
    if (char === "/" && !inCharacterClass) {
      return index;
    }
  }
  return source.length;
};

export const readQuotedLiteralSegment: SegmentReader = ({ index, source }) => {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") {
    return;
  }
  const end = skipQuotedLiteral(source, index, quote);
  return {
    index: end,
    text: source.slice(index, end),
  };
};

export const readLineCommentSegment: SegmentReader = ({ index, source }) => {
  if (source[index] !== "/" || source[index + 1] !== "/") {
    return;
  }
  const end = skipLineComment(source, index);
  return {
    index: end,
    text: source.slice(index, end),
  };
};

export const readBlockCommentSegment: SegmentReader = ({ index, source }) => {
  if (source[index] !== "/" || source[index + 1] !== "*") {
    return;
  }
  const end = skipBlockComment(source, index);
  return {
    index: end,
    text: source.slice(index, end),
  };
};

export const readRegexLiteralSegment: SegmentReader = ({ index, source }) => {
  if (source[index] !== "/" || !shouldSkipRegexLiteral(source, index)) {
    return;
  }
  const end = skipRegexLiteral(source, index);
  return {
    index: end,
    text: source.slice(index, end),
  };
};

export { isIdentifierPart, hasImportMetaLeadingBoundary };
export type { RewriteSegment, SegmentReader };
