import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { hydratePromisedSnapshotBlobs } from "./git-snapshot-hydration.ts";
import { contentHash, sha256 } from "./hash.ts";
import type { TaskEpisode } from "./types.ts";
import { redactText } from "./validation.ts";

const execFileAsync = promisify(execFile);

export const LUNA_REPOSITORY_RETRIEVAL_VERSION =
  "luna-repository-retrieval-v2-task-aware-lexical" as const;
export const LUNA_REPOSITORY_RETRIEVAL_DEFAULT_MAXIMUM_CHARACTERS = 6_000;
export const LUNA_REPOSITORY_RETRIEVAL_DEFAULT_MAXIMUM_FILES = 8;
export const LUNA_REPOSITORY_RETRIEVAL_DEFAULT_MAXIMUM_SNIPPET_CHARACTERS =
  640;
export const LUNA_REPOSITORY_RETRIEVAL_MAXIMUM_FILE_BYTES = 512 * 1024;

export type LunaRepositoryRetrievalMode =
  | "paths"
  | "paths_and_symbols"
  | "paths_and_snippets";

export interface LunaRepositoryRetrievalOptions {
  mode: LunaRepositoryRetrievalMode;
  maximumCharacters?: number;
  maximumFiles?: number;
  maximumSnippetCharacters?: number;
}

export interface LunaRepositoryRetrievalSymbolV2 {
  signature: string;
  line: number;
  signatureSha256: string;
}

export interface LunaRepositoryRetrievalMatchV2 {
  path: string;
  score: number;
  matchedTerms: string[];
  pathMatchedTerms: string[];
  contentMatchedTerms: string[];
  matchedPhrases: string[];
  symbols?: LunaRepositoryRetrievalSymbolV2[];
  snippet?: {
    startLine: number;
    endLine: number;
    text: string;
    textSha256: string;
    clipped: boolean;
  };
}

/** Backward-compatible source name for consumers of retrieval v1. */
export type LunaRepositoryRetrievalMatchV1 = LunaRepositoryRetrievalMatchV2;

export interface LunaRepositoryRetrievalProvenanceV2 {
  schemaVersion: 2;
  specificationVersion: typeof LUNA_REPOSITORY_RETRIEVAL_VERSION;
  repositoryIdHash: string;
  repositorySnapshot: string;
  snapshotTreeHash: string;
  querySha256: string;
  queryTermsSha256: string;
  queryPhrasesSha256: string;
  repositoryPathInventorySha256: string;
  resultSha256: string;
  retrievalMode: LunaRepositoryRetrievalMode;
  maximumCharacters: number;
  maximumFiles: number;
  maximumSnippetCharacters: number;
  filesAtSnapshot: number;
  candidateFilesInspected: number;
  selectedFiles: number;
  renderedCharacters: number;
  redactionsApplied: number;
  querySource: "task_aware_context";
  repositorySource: "exact_pre_task_git_snapshot";
  externalCallsMade: 0;
  labelsRead: false;
  predictionsRead: false;
  actualChangedPathsRead: false;
  postTaskDiffsRead: false;
  workingTreeRead: false;
}

export interface LunaRepositoryRetrievalResultV2 {
  schemaVersion: 2;
  diagnostic: string;
  matches: LunaRepositoryRetrievalMatchV2[];
  provenance: LunaRepositoryRetrievalProvenanceV2;
}

export type LunaRepositoryRetrievalResultV1 = LunaRepositoryRetrievalResultV2;

export interface LunaRepositoryRetrievalAugmentationV2 {
  episode: TaskEpisode;
  retrieval: LunaRepositoryRetrievalResultV2;
}

export type LunaRepositoryRetrievalAugmentationV1 =
  LunaRepositoryRetrievalAugmentationV2;

interface EffectiveOptions {
  mode: LunaRepositoryRetrievalMode;
  maximumCharacters: number;
  maximumFiles: number;
  maximumSnippetCharacters: number;
}

interface RetrievalQuery {
  text: string;
  terms: string[];
  phrases: string[];
}

interface FileCandidate {
  path: string;
  size: number;
  pathTerms: string[];
  contentTerms: string[];
  matchedPhrases: string[];
  score: number;
  content?: string;
  bestLine?: number;
  symbols?: LunaRepositoryRetrievalSymbolV2[];
  redactions: number;
}

interface RepositoryFile {
  path: string;
  size: number;
}

const MINIMUM_MAXIMUM_CHARACTERS = 256;
const MAXIMUM_MAXIMUM_CHARACTERS = 64_000;
const MINIMUM_MAXIMUM_FILES = 1;
const MAXIMUM_MAXIMUM_FILES = 64;
const MINIMUM_SNIPPET_CHARACTERS = 80;
const MAXIMUM_SNIPPET_CHARACTERS = 8_000;
const MAXIMUM_QUERY_TERMS = 96;
const MAXIMUM_QUERY_TERM_CHARACTERS = 64;
const MAXIMUM_QUERY_CHARACTERS = 24_000;
const MAXIMUM_PATH_CANDIDATES_FOR_CONTENT_SCAN = 1_024;
const SNIPPET_OMISSION_MARKER = "\n…[snippet clipped]…\n";
const DIAGNOSTIC_HEADER = "[PRE-TASK REPOSITORY RETRIEVAL]";

const STOP_WORDS = new Set([
  "a", "about", "add", "after", "all", "also", "an", "and", "any",
  "are", "as", "at", "be", "because", "before", "but", "by", "can",
  "change", "code", "could", "do", "does", "doing", "done", "for",
  "from", "get", "go", "have", "help", "how", "i", "if", "implement",
  "in", "into", "is", "it", "its", "just", "make", "me", "my",
  "need", "not", "now", "of", "on", "or", "our", "please", "run",
  "should", "so", "some", "that", "the", "their", "then", "there",
  "this", "to", "up", "use", "want", "we", "what", "when", "where",
  "which", "will", "with", "would", "you", "your", "feat", "fix",
  "hotfix", "refactor", "codex",
]);

const ignoredPathPrefixes = [
  ".git/", ".turbo/", "coverage/", "dist/", "node_modules/", "vendor/",
];

const ignoredBasenames = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);

const likelyTextExtensions = new Set([
  "", ".bash", ".c", ".cjs", ".conf", ".cpp", ".css", ".csv", ".env",
  ".go", ".graphql", ".h", ".hpp", ".html", ".ini", ".java", ".js",
  ".json", ".jsonc", ".jsx", ".md", ".mdx", ".mjs", ".mts", ".py",
  ".rb", ".rs", ".sh", ".sql", ".svg", ".tf", ".toml", ".ts",
  ".tsx", ".txt", ".yaml", ".yml", ".zsh",
]);

const compareLexically = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
};

const resolveOptions = (
  options: LunaRepositoryRetrievalOptions,
): EffectiveOptions => {
  if (
    options.mode !== "paths" &&
    options.mode !== "paths_and_symbols" &&
    options.mode !== "paths_and_snippets"
  ) {
    throw new Error(`Unsupported repository retrieval mode: ${options.mode}`);
  }
  return {
    mode: options.mode,
    maximumCharacters: positiveInteger(
      options.maximumCharacters,
      LUNA_REPOSITORY_RETRIEVAL_DEFAULT_MAXIMUM_CHARACTERS,
      MINIMUM_MAXIMUM_CHARACTERS,
      MAXIMUM_MAXIMUM_CHARACTERS,
      "maximumCharacters",
    ),
    maximumFiles: positiveInteger(
      options.maximumFiles,
      LUNA_REPOSITORY_RETRIEVAL_DEFAULT_MAXIMUM_FILES,
      MINIMUM_MAXIMUM_FILES,
      MAXIMUM_MAXIMUM_FILES,
      "maximumFiles",
    ),
    maximumSnippetCharacters: positiveInteger(
      options.maximumSnippetCharacters,
      LUNA_REPOSITORY_RETRIEVAL_DEFAULT_MAXIMUM_SNIPPET_CHARACTERS,
      MINIMUM_SNIPPET_CHARACTERS,
      MAXIMUM_SNIPPET_CHARACTERS,
      "maximumSnippetCharacters",
    ),
  };
};

const assertSafeSnapshot = (snapshot: string): void => {
  if (!/^[0-9a-f]{7,64}$/u.test(snapshot)) {
    throw new Error(
      "repositorySnapshot must be a lowercase hexadecimal object ID; symbolic revisions are not accepted",
    );
  }
};

const runGitBuffer = async (
  repository: string,
  args: readonly string[],
  maximumBytes: number,
): Promise<Buffer> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await execFileAsync("git", ["-C", repository, ...args], {
        encoding: "buffer",
        maxBuffer: maximumBytes,
        windowsHide: true,
      });
      return result.stdout as Buffer;
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      const transient =
        /SSL connection timeout|could not fetch .* from promisor remote|RPC failed|remote end hung up|HTTP (?:408|429|5\d\d)/iu.test(
          detail,
        );
      if (!transient || attempt === 2) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 1_000 * 2 ** attempt),
      );
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Git repository retrieval failed: ${detail}`);
};

const resolveExactCommit = async (
  repository: string,
  snapshot: string,
): Promise<string> => {
  assertSafeSnapshot(snapshot);
  const resolved = (
    await runGitBuffer(
      repository,
      ["rev-parse", "--verify", `${snapshot}^{commit}`],
      1024 * 1024,
    )
  ).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(resolved)) {
    throw new Error(`Could not resolve repository snapshot ${snapshot}`);
  }
  if (!resolved.startsWith(snapshot)) {
    throw new Error(
      `Resolved repository snapshot ${resolved} does not match requested ${snapshot}`,
    );
  }
  return resolved;
};

const treeHash = async (
  repository: string,
  resolvedSnapshot: string,
): Promise<string> => {
  const resolved = (
    await runGitBuffer(
      repository,
      ["rev-parse", "--verify", `${resolvedSnapshot}^{tree}`],
      1024 * 1024,
    )
  ).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(resolved)) {
    throw new Error(`Could not resolve tree for repository snapshot ${resolvedSnapshot}`);
  }
  return resolved;
};

const repositoryPaths = async (
  repository: string,
  resolvedSnapshot: string,
): Promise<RepositoryFile[]> => {
  const output = await runGitBuffer(
    repository,
    ["ls-tree", "-r", "-z", "-l", "--full-tree", resolvedSnapshot],
    64 * 1024 * 1024,
  );
  const files = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((row): RepositoryFile => {
      const separator = row.indexOf("\t");
      if (separator < 0) {
        throw new Error("Repository tree contains an unparseable entry");
      }
      const metadata = row.slice(0, separator).trim().split(/\s+/u);
      const size = Number(metadata[3]);
      const filePath = row.slice(separator + 1);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(
          `Repository tree contains an invalid blob size: ${filePath}`,
        );
      }
      return { path: filePath, size };
    })
    .sort((left, right) => compareLexically(left.path, right.path));
  if (
    files.some(({ path }) =>
      path.includes("\u0000") || path.includes("\n")
    )
  ) {
    throw new Error("Repository contains a path that cannot be rendered safely");
  }
  return files;
};

const extension = (path: string): string => {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
};

const isEligiblePath = (path: string): boolean => {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    !ignoredPathPrefixes.some(
      (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
    ) &&
    !ignoredBasenames.has(basename) &&
    likelyTextExtensions.has(extension(path))
  );
};

const normalizeStem = (token: string): string => {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
};

const identifierPieces = (token: string): string[] => {
  const separated = token.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return separated
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .map(normalizeStem);
};

const rawQueryTerms = (text: string): string[] => {
  const rawTokens = text.normalize("NFKC").match(/[\p{L}\p{N}_./:@+-]+/gu) ?? [];
  const terms: string[] = [];
  for (const rawToken of rawTokens) {
    for (const piece of identifierPieces(rawToken)) {
      if (
        piece.length < 2 ||
        piece.length > MAXIMUM_QUERY_TERM_CHARACTERS ||
        STOP_WORDS.has(piece) ||
        /^\d+$/u.test(piece)
      ) continue;
      terms.push(piece);
    }
  }
  return terms;
};

/** Extracts stable bounded lexical terms from one task text field. */
export const extractLunaRepositoryRetrievalTerms = (
  currentRequest: string,
): string[] => [...new Set(rawQueryTerms(currentRequest))]
  .sort(compareLexically)
  .slice(0, MAXIMUM_QUERY_TERMS);

const taskAwareQueryText = (episode: TaskEpisode): string =>
  [
    episode.taskAnchor,
    ...(episode.earlierUserContext ?? []),
    episode.precedingAssistant,
    episode.relevantDiagnostic,
    episode.currentRequest,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .slice(-MAXIMUM_QUERY_CHARACTERS);

const buildTaskAwareQuery = (episode: TaskEpisode): RetrievalQuery => {
  const text = taskAwareQueryText(episode);
  const ordered = rawQueryTerms(text);
  const frequency = new Map<string, number>();
  for (const term of ordered) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const terms = [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || compareLexically(left[0], right[0]))
    .slice(0, MAXIMUM_QUERY_TERMS)
    .map(([term]) => term);
  const allowed = new Set(terms);
  const filtered = ordered.filter((term) => allowed.has(term));
  const phrases = new Set<string>();
  for (const size of [4, 3, 2]) {
    for (let index = 0; index + size <= filtered.length; index += 1) {
      const phrase = filtered.slice(index, index + size).join(" ");
      if (new Set(phrase.split(" ")).size > 1) phrases.add(phrase);
      if (phrases.size >= 64) break;
    }
    if (phrases.size >= 64) break;
  }
  return { text, terms: terms.sort(compareLexically), phrases: [...phrases] };
};

const textTermMatches = (value: string, terms: readonly string[]): string[] => {
  const valueTerms = new Set(rawQueryTerms(value));
  return terms.filter((term) => valueTerms.has(term));
};

const pathScore = (path: string, terms: readonly string[]): number => {
  const pathTerms = new Set(identifierPieces(path));
  const basename = new Set(identifierPieces(path.slice(path.lastIndexOf("/") + 1)));
  let score = 0;
  for (const term of terms) {
    if (basename.has(term)) score += 18;
    else if (pathTerms.has(term)) score += 12;
  }
  return score;
};

const readSnapshotFile = async (
  repository: string,
  resolvedSnapshot: string,
  path: string,
  size: number,
): Promise<{ content?: string; redactions: number }> => {
  if (size > LUNA_REPOSITORY_RETRIEVAL_MAXIMUM_FILE_BYTES) {
    return { redactions: 0 };
  }
  const content = await runGitBuffer(
    repository,
    ["show", `${resolvedSnapshot}:${path}`],
    LUNA_REPOSITORY_RETRIEVAL_MAXIMUM_FILE_BYTES + 1024,
  );
  if (content.includes(0)) return { redactions: 0 };
  const redacted = redactText(content.toString("utf8").replaceAll("\r\n", "\n"));
  return { content: redacted.text, redactions: redacted.redactions };
};

const countPhrase = (value: string, phrase: string): number => {
  let count = 0;
  let offset = 0;
  while (count < 3) {
    const found = value.indexOf(phrase, offset);
    if (found < 0) break;
    count += 1;
    offset = found + phrase.length;
  }
  return count;
};

const scoreContent = (
  content: string,
  query: RetrievalQuery,
): {
  terms: string[];
  phrases: string[];
  score: number;
  bestLine: number | undefined;
} => {
  const lines = content.split("\n");
  const matched = new Set<string>();
  const matchedPhrases = new Set<string>();
  let totalOccurrences = 0;
  let bestLine: number | undefined;
  let bestLineScore = 0;
  const normalizedLines = lines.map((line) => rawQueryTerms(line).join(" "));
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const normalized = normalizedLines[index]!;
    let lineScore = 0;
    for (const term of query.terms) {
      const occurrences = countPhrase(normalized, term);
      if (occurrences > 0) {
        matched.add(term);
        lineScore += occurrences;
        totalOccurrences += occurrences;
      }
    }
    for (const phrase of query.phrases) {
      const occurrences = countPhrase(normalized, phrase);
      if (occurrences > 0) {
        matchedPhrases.add(phrase);
        lineScore += occurrences * phrase.split(" ").length * 5;
      }
    }
    if (lineScore > bestLineScore) {
      bestLine = index;
      bestLineScore = lineScore;
    }
  }
  return {
    terms: [...matched].sort(compareLexically),
    phrases: [...matchedPhrases].sort(compareLexically),
    score:
      matched.size * 4 +
      Math.min(totalOccurrences, 20) +
      [...matchedPhrases].reduce(
        (sum, phrase) => sum + phrase.split(" ").length * 14,
        0,
      ),
    bestLine,
  };
};

const clipSnippet = (
  value: string,
  maximumCharacters: number,
): { text: string; clipped: boolean } => {
  if (value.length <= maximumCharacters) return { text: value, clipped: false };
  const available = maximumCharacters - SNIPPET_OMISSION_MARKER.length;
  const head = Math.ceil(available * 0.7);
  return {
    text: `${value.slice(0, head)}${SNIPPET_OMISSION_MARKER}${value.slice(-(available - head))}`,
    clipped: true,
  };
};

const buildSnippet = (
  content: string,
  bestLine: number,
  maximumCharacters: number,
): NonNullable<LunaRepositoryRetrievalMatchV2["snippet"]> => {
  const lines = content.split("\n");
  let start = bestLine;
  let end = bestLine;
  let text = lines[bestLine] ?? "";
  while (true) {
    const previous = start > 0 ? lines[start - 1] : undefined;
    const next = end + 1 < lines.length ? lines[end + 1] : undefined;
    if (previous === undefined && next === undefined) break;
    const usePrevious =
      previous !== undefined &&
      (next === undefined || bestLine - start <= end - bestLine);
    const candidate = usePrevious ? `${previous}\n${text}` : `${text}\n${next ?? ""}`;
    if (candidate.length > maximumCharacters * 2) break;
    if (usePrevious) start -= 1;
    else end += 1;
    text = candidate;
  }
  const clipped = clipSnippet(text, maximumCharacters);
  return {
    startLine: start + 1,
    endLine: end + 1,
    text: clipped.text,
    textSha256: sha256(clipped.text),
    clipped: clipped.clipped,
  };
};

const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+[A-Za-z_$][\w$]*[^\n]{0,220}/u,
  /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+[A-Za-z_$][\w$]*[^\n]{0,220}/u,
  /^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_][\w]*[^\n]{0,220}/u,
  /^\s*(?:resource|module|variable|output|data)\s+"[^"]+"(?:\s+"[^"]+")?/u,
];

const extractSymbols = (
  content: string,
  query: RetrievalQuery,
  bestLine: number | undefined,
): LunaRepositoryRetrievalSymbolV2[] => {
  const lines = content.split("\n");
  const candidates: Array<LunaRepositoryRetrievalSymbolV2 & { score: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const signature = lines[index]!.trim();
    if (!signature || !SYMBOL_PATTERNS.some((pattern) => pattern.test(signature))) continue;
    const terms = textTermMatches(signature, query.terms);
    const distance = bestLine === undefined ? 10_000 : Math.abs(index - bestLine);
    const score = terms.length * 20 + Math.max(0, 10 - distance);
    if (score <= 0 && distance > 12) continue;
    candidates.push({
      signature: clipSnippet(signature, 260).text,
      line: index + 1,
      signatureSha256: sha256(signature),
      score,
    });
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.line - right.line)
    .slice(0, 6)
    .map(({ score: _score, ...symbol }) => symbol);
};

const rankCandidates = async (
  repository: string,
  resolvedSnapshot: string,
  files: readonly RepositoryFile[],
  query: RetrievalQuery,
  options: EffectiveOptions,
): Promise<{ candidates: FileCandidate[]; inspected: number; redactions: number }> => {
  const pathCandidates = files.filter(({ path }) => isEligiblePath(path)).map((file): FileCandidate => ({
    path: file.path,
    size: file.size,
    pathTerms: textTermMatches(file.path, query.terms),
    contentTerms: [],
    matchedPhrases: [],
    score: pathScore(file.path, query.terms),
    redactions: 0,
  }));
  const pathPreferred = [...pathCandidates]
    .sort((left, right) => right.score - left.score || compareLexically(left.path, right.path));
  const scan = pathPreferred.length <= MAXIMUM_PATH_CANDIDATES_FOR_CONTENT_SCAN
    ? pathPreferred
    : [
      ...pathPreferred.slice(0, Math.floor(MAXIMUM_PATH_CANDIDATES_FOR_CONTENT_SCAN / 2)),
      ...pathPreferred
        .slice(Math.floor(MAXIMUM_PATH_CANDIDATES_FOR_CONTENT_SCAN / 2))
        .sort((left, right) => compareLexically(left.path, right.path))
        .slice(0, Math.ceil(MAXIMUM_PATH_CANDIDATES_FOR_CONTENT_SCAN / 2)),
    ];
  const readConcurrency = 32;
  let inspected = 0;
  let redactions = 0;
  for (let offset = 0; offset < scan.length; offset += readConcurrency) {
    const batch = scan.slice(offset, offset + readConcurrency);
    const reads = await Promise.all(
      batch.map((candidate) =>
        readSnapshotFile(
          repository,
          resolvedSnapshot,
          candidate.path,
          candidate.size,
        )
      ),
    );
    for (const [index, candidate] of batch.entries()) {
      const read = reads[index]!;
      if (read.content === undefined) continue;
      inspected += 1;
      redactions += read.redactions;
      const scored = scoreContent(read.content, query);
      candidate.contentTerms = scored.terms;
      candidate.matchedPhrases = scored.phrases;
      candidate.score += scored.score;
      candidate.content = read.content;
      if (scored.bestLine !== undefined) {
        candidate.bestLine = scored.bestLine;
      }
      candidate.redactions = read.redactions;
      if (options.mode === "paths_and_symbols") {
        candidate.symbols = extractSymbols(
          read.content,
          query,
          scored.bestLine,
        );
      }
    }
  }
  return {
    candidates: pathCandidates
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || compareLexically(left.path, right.path))
      .slice(0, options.maximumFiles),
    inspected,
    redactions,
  };
};

const publicMatch = (
  candidate: FileCandidate,
  options: EffectiveOptions,
): LunaRepositoryRetrievalMatchV2 => {
  const base: LunaRepositoryRetrievalMatchV2 = {
    path: candidate.path,
    score: candidate.score,
    matchedTerms: [...new Set([...candidate.pathTerms, ...candidate.contentTerms])]
      .sort(compareLexically),
    pathMatchedTerms: [...candidate.pathTerms].sort(compareLexically),
    contentMatchedTerms: [...candidate.contentTerms].sort(compareLexically),
    matchedPhrases: [...candidate.matchedPhrases].sort(compareLexically),
  };
  if (options.mode === "paths_and_symbols" && candidate.symbols?.length) {
    base.symbols = candidate.symbols;
  }
  if (
    options.mode === "paths_and_snippets" &&
    candidate.content !== undefined &&
    candidate.bestLine !== undefined
  ) {
    base.snippet = buildSnippet(
      candidate.content,
      candidate.bestLine,
      options.maximumSnippetCharacters,
    );
  }
  return base;
};

const renderMatch = (
  match: LunaRepositoryRetrievalMatchV2,
  mode: LunaRepositoryRetrievalMode,
): string => {
  const terms = match.matchedTerms.join(", ");
  const phrases = match.matchedPhrases.length
    ? `; phrases=${match.matchedPhrases.join(" | ")}`
    : "";
  if (mode === "paths") {
    return `- ${match.path} [score=${match.score}; terms=${terms}${phrases}]`;
  }
  if (mode === "paths_and_symbols") {
    return [
      `- ${match.path} [score=${match.score}; terms=${terms}${phrases}]`,
      ...(match.symbols?.map((symbol) => `  L${symbol.line}: ${symbol.signature}`) ?? [
        "  (no matching symbol signature)",
      ]),
    ].join("\n");
  }
  const snippet = match.snippet;
  if (!snippet) {
    return `- ${match.path} [score=${match.score}; terms=${terms}${phrases}; snippet=unavailable]`;
  }
  return [
    `- ${match.path}:${snippet.startLine}-${snippet.endLine} [score=${match.score}; terms=${terms}${phrases}]`,
    "```text",
    snippet.text,
    "```",
  ].join("\n");
};

const renderDiagnostic = (
  matches: readonly LunaRepositoryRetrievalMatchV2[],
  mode: LunaRepositoryRetrievalMode,
  maximumCharacters: number,
): { diagnostic: string; included: LunaRepositoryRetrievalMatchV2[] } => {
  const prefix = [
    DIAGNOSTIC_HEADER,
    "Deterministic lexical matches from the exact pre-task git snapshot, queried from task-aware context. These are search hints, not labels or known changed files.",
  ].join("\n");
  if (matches.length === 0) {
    return {
      diagnostic: `${prefix}\nNo lexical repository match was found.`.slice(0, maximumCharacters),
      included: [],
    };
  }
  const included: LunaRepositoryRetrievalMatchV2[] = [];
  let diagnostic = prefix;
  for (const match of matches) {
    const block = renderMatch(match, mode);
    if (`${diagnostic}\n${block}`.length > maximumCharacters) break;
    diagnostic = `${diagnostic}\n${block}`;
    included.push(match);
  }
  if (included.length === 0) {
    const {
      symbols: _symbols,
      snippet: _snippet,
      ...fallback
    } = matches[0]!;
    diagnostic = `${prefix}\n${renderMatch(fallback, "paths")}`.slice(0, maximumCharacters);
    included.push(fallback);
  }
  return { diagnostic, included };
};

/**
 * Retrieves task-specific evidence using only task-aware context and the exact
 * pre-task Git snapshot. Labels, predictions, changed paths, diffs, and the
 * working tree are deliberately absent from this API.
 */
export const retrieveLunaRepositoryContext = async (input: {
  repository: string;
  episode: TaskEpisode;
  options: LunaRepositoryRetrievalOptions;
}): Promise<LunaRepositoryRetrievalResultV2> => {
  const options = resolveOptions(input.options);
  const resolvedSnapshot = await resolveExactCommit(
    input.repository,
    input.episode.repositorySnapshot,
  );
  await hydratePromisedSnapshotBlobs(input.repository, resolvedSnapshot);
  const snapshotTreeHash = await treeHash(input.repository, resolvedSnapshot);
  const files = await repositoryPaths(input.repository, resolvedSnapshot);
  const paths = files.map(({ path }) => path);
  const query = buildTaskAwareQuery(input.episode);
  const ranked = query.terms.length === 0
    ? { candidates: [] as FileCandidate[], inspected: 0, redactions: 0 }
    : await rankCandidates(input.repository, resolvedSnapshot, files, query, options);
  const rendered = renderDiagnostic(
    ranked.candidates.map((candidate) => publicMatch(candidate, options)),
    options.mode,
    options.maximumCharacters,
  );
  const resultBinding = {
    specificationVersion: LUNA_REPOSITORY_RETRIEVAL_VERSION,
    repositoryIdHash: sha256(input.episode.repositoryId),
    repositorySnapshot: resolvedSnapshot,
    snapshotTreeHash,
    querySha256: sha256(query.text),
    queryTerms: query.terms,
    queryPhrases: query.phrases,
    repositoryPaths: paths,
    retrievalMode: options.mode,
    limits: options,
    matches: rendered.included,
    diagnostic: rendered.diagnostic,
  };
  return {
    schemaVersion: 2,
    diagnostic: rendered.diagnostic,
    matches: rendered.included,
    provenance: {
      schemaVersion: 2,
      specificationVersion: LUNA_REPOSITORY_RETRIEVAL_VERSION,
      repositoryIdHash: resultBinding.repositoryIdHash,
      repositorySnapshot: resolvedSnapshot,
      snapshotTreeHash,
      querySha256: resultBinding.querySha256,
      queryTermsSha256: contentHash(query.terms),
      queryPhrasesSha256: contentHash(query.phrases),
      repositoryPathInventorySha256: contentHash(paths),
      resultSha256: contentHash(resultBinding),
      retrievalMode: options.mode,
      maximumCharacters: options.maximumCharacters,
      maximumFiles: options.maximumFiles,
      maximumSnippetCharacters: options.maximumSnippetCharacters,
      filesAtSnapshot: paths.length,
      candidateFilesInspected: ranked.inspected,
      selectedFiles: rendered.included.length,
      renderedCharacters: rendered.diagnostic.length,
      redactionsApplied: ranked.redactions,
      querySource: "task_aware_context",
      repositorySource: "exact_pre_task_git_snapshot",
      externalCallsMade: 0,
      labelsRead: false,
      predictionsRead: false,
      actualChangedPathsRead: false,
      postTaskDiffsRead: false,
      workingTreeRead: false,
    },
  };
};

/** Returns a runtime-safe episode with retrieval appended to its diagnostic. */
export const augmentEpisodeWithLunaRepositoryContext = async (input: {
  repository: string;
  episode: TaskEpisode;
  options: LunaRepositoryRetrievalOptions;
}): Promise<LunaRepositoryRetrievalAugmentationV2> => {
  const retrieval = await retrieveLunaRepositoryContext(input);
  const { actualChangedPaths: _removed, ...runtimeEpisode } = input.episode;
  const relevantDiagnostic = [
    input.episode.relevantDiagnostic?.trim(),
    retrieval.diagnostic,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  return {
    episode: { ...runtimeEpisode, relevantDiagnostic } as TaskEpisode,
    retrieval,
  };
};

export interface LunaRepositoryRetrievalMaterializationV1 {
  schemaVersion: 1;
  specificationVersion: typeof LUNA_REPOSITORY_RETRIEVAL_VERSION;
  generatedAt: string;
  repository: string;
  options: EffectiveOptions;
  episodes: number;
  hashes: {
    sourceEpisodes: string;
    runtimeEpisodes: string;
    retrievalResults: string;
  };
  safeguards: {
    taskAwareContextOnly: true;
    exactPreTaskSnapshots: true;
    labelsRead: false;
    predictionsRead: false;
    actualChangedPathsRead: false;
    postTaskDiffsRead: false;
    workingTreeRead: false;
    externalCallsMade: 0;
  };
  retrievalSummary: {
    episodesWithMatches: number;
    selectedFiles: number;
    minimumSelectedFiles: number;
    maximumSelectedFiles: number;
    renderedCharacters: number;
    redactionsApplied: number;
  };
}

const writeImmutablePrivate = async (
  file: string,
  value: string,
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Materializes a complete leakage-safe retrieval treatment without labels. */
export const materializeLunaRepositoryRetrievalEpisodes = async (input: {
  repository: string;
  episodes: TaskEpisode[];
  options: LunaRepositoryRetrievalOptions;
  generatedAt?: string;
}): Promise<{
  episodes: TaskEpisode[];
  retrievals: LunaRepositoryRetrievalResultV2[];
  manifest: LunaRepositoryRetrievalMaterializationV1;
}> => {
  if (input.episodes.length === 0) {
    throw new Error("Repository retrieval materialization requires episodes");
  }
  const ids = new Set<string>();
  const augmented: LunaRepositoryRetrievalAugmentationV2[] = [];
  for (const episode of input.episodes) {
    if (ids.has(episode.id)) throw new Error(`Duplicate retrieval episode: ${episode.id}`);
    ids.add(episode.id);
    augmented.push(await augmentEpisodeWithLunaRepositoryContext({
      repository: input.repository,
      episode,
      options: input.options,
    }));
  }
  const episodes = augmented.map((item) => item.episode);
  const retrievals = augmented.map((item) => item.retrieval);
  const effective = resolveOptions(input.options);
  const selected = retrievals.map((item) => item.provenance.selectedFiles);
  return {
    episodes,
    retrievals,
    manifest: {
      schemaVersion: 1,
      specificationVersion: LUNA_REPOSITORY_RETRIEVAL_VERSION,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      repository: input.repository,
      options: effective,
      episodes: episodes.length,
      hashes: {
        sourceEpisodes: contentHash(
          input.episodes.map(({ actualChangedPaths: _removed, ...episode }) => episode),
        ),
        runtimeEpisodes: contentHash(episodes),
        retrievalResults: contentHash(retrievals),
      },
      safeguards: {
        taskAwareContextOnly: true,
        exactPreTaskSnapshots: true,
        labelsRead: false,
        predictionsRead: false,
        actualChangedPathsRead: false,
        postTaskDiffsRead: false,
        workingTreeRead: false,
        externalCallsMade: 0,
      },
      retrievalSummary: {
        episodesWithMatches: selected.filter((count) => count > 0).length,
        selectedFiles: selected.reduce((sum, count) => sum + count, 0),
        minimumSelectedFiles: Math.min(...selected),
        maximumSelectedFiles: Math.max(...selected),
        renderedCharacters: retrievals.reduce(
          (sum, item) => sum + item.provenance.renderedCharacters,
          0,
        ),
        redactionsApplied: retrievals.reduce(
          (sum, item) => sum + item.provenance.redactionsApplied,
          0,
        ),
      },
    },
  };
};

/**
 * Atomically persists one frozen treatment. Existing outputs are never
 * overwritten, so hashes recorded before hosted inference remain auditable.
 */
export const writeLunaRepositoryRetrievalMaterialization = async (input: {
  outputDirectory: string;
  materialization: Awaited<
    ReturnType<typeof materializeLunaRepositoryRetrievalEpisodes>
  >;
}): Promise<{
  episodes: string;
  retrievals: string;
  manifest: string;
}> => {
  const outputDirectory = path.resolve(input.outputDirectory);
  try {
    await access(outputDirectory);
    throw new Error(
      `Repository retrieval materialization already exists: ${outputDirectory}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files = {
    episodes: path.join(outputDirectory, "episodes.jsonl"),
    retrievals: path.join(outputDirectory, "retrievals.jsonl"),
    manifest: path.join(outputDirectory, "manifest.json"),
  };
  let created = false;
  try {
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
    created = true;
    await writeImmutablePrivate(
      files.episodes,
      `${input.materialization.episodes.map((episode) =>
        JSON.stringify(episode)
      ).join("\n")}\n`,
    );
    await writeImmutablePrivate(
      files.retrievals,
      `${input.materialization.retrievals.map((retrieval) =>
        JSON.stringify(retrieval)
      ).join("\n")}\n`,
    );
    await writeImmutablePrivate(
      files.manifest,
      `${JSON.stringify(input.materialization.manifest, null, 2)}\n`,
    );
  } catch (error) {
    if (created) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  return files;
};
