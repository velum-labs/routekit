import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentHash, sha256 } from "./hash.ts";
import type { TaskEpisode } from "./types.ts";
import { redactText } from "./validation.ts";

const execFileAsync = promisify(execFile);

export const LUNA_BOUNDED_REPOSITORY_TOOLS_VERSION =
  "luna-bounded-repository-tools-v1" as const;

export type LunaRepositoryAccessMode =
  | "candidate_read"
  | "search_and_read";

export interface LunaBoundedRepositoryToolPolicy {
  maximumSearchCalls: number;
  maximumReadCalls: number;
  maximumSearchResults: number;
  maximumSearchOutputCharacters: number;
  maximumReadOutputCharacters: number;
  maximumTotalToolOutputCharacters: number;
  maximumFileBytes: number;
}

export const DEFAULT_LUNA_BOUNDED_REPOSITORY_TOOL_POLICY =
  Object.freeze({
    maximumSearchCalls: 1,
    maximumReadCalls: 2,
    maximumSearchResults: 8,
    maximumSearchOutputCharacters: 3_000,
    maximumReadOutputCharacters: 4_000,
    maximumTotalToolOutputCharacters: 10_000,
    maximumFileBytes: 512 * 1024,
  }) satisfies Readonly<LunaBoundedRepositoryToolPolicy>;

export interface LunaRepositorySearchMatch {
  path: string;
  score: number;
  matchedTerms: string[];
  line: number;
  preview: string;
}

export interface LunaRepositoryToolCallRecord {
  index: number;
  name: "search_repository" | "read_repository_excerpt";
  arguments: Record<string, unknown>;
  ok: boolean;
  outputCharacters: number;
  outputSha256: string;
  resultPaths: string[];
  redactionsApplied: number;
  errorCode?: string;
}

export interface LunaBoundedRepositoryToolSessionSummary {
  schemaVersion: 1;
  specificationVersion: typeof LUNA_BOUNDED_REPOSITORY_TOOLS_VERSION;
  mode: LunaRepositoryAccessMode;
  repositorySnapshot: string;
  repositorySnapshotTree: string;
  candidatePaths: string[];
  searchablePaths: number;
  searchCalls: number;
  readCalls: number;
  toolOutputCharacters: number;
  toolCallRecords: LunaRepositoryToolCallRecord[];
  allowedReadPaths: string[];
  policy: LunaBoundedRepositoryToolPolicy;
  safety: {
    exactPreTaskSnapshotOnly: true;
    workingTreeRead: false;
    postTaskDiffRead: false;
    labelsRead: false;
    predictionsRead: false;
    networkAccess: false;
    writesAllowed: false;
    arbitraryShellAllowed: false;
  };
  sessionSha256: string;
}

export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: "search_repository" | "read_repository_excerpt";
    description: string;
    parameters: Record<string, unknown>;
    strict: true;
  };
}

export interface LunaBoundedRepositoryToolSession {
  readonly mode: LunaRepositoryAccessMode;
  readonly candidatePaths: readonly string[];
  readonly searchTool: OpenAiFunctionTool;
  readonly readTool: OpenAiFunctionTool;
  execute(
    name: string,
    rawArguments: string | Record<string, unknown>,
  ): Promise<{
    content: string;
    record: LunaRepositoryToolCallRecord;
  }>;
  summary(): LunaBoundedRepositoryToolSessionSummary;
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

const ignoredPathPrefixes = [
  ".git/",
  ".turbo/",
  "coverage/",
  "dist/",
  "node_modules/",
  "vendor/",
] as const;

const ignoredBasenames = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const likelyTextExtensions = new Set([
  "",
  ".bash",
  ".c",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".tf",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
  ".zsh",
]);

const stopWords = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "because",
  "before",
  "but",
  "can",
  "change",
  "code",
  "could",
  "does",
  "doing",
  "done",
  "for",
  "from",
  "have",
  "help",
  "how",
  "implement",
  "into",
  "its",
  "just",
  "make",
  "need",
  "not",
  "now",
  "our",
  "please",
  "repository",
  "should",
  "some",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "use",
  "want",
  "what",
  "when",
  "where",
  "which",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const extension = (value: string): string => {
  const basename = value.slice(value.lastIndexOf("/") + 1);
  const offset = basename.lastIndexOf(".");
  return offset < 0 ? "" : basename.slice(offset).toLowerCase();
};

const eligiblePath = (value: string): boolean => {
  const basename = value.slice(value.lastIndexOf("/") + 1);
  return (
    !value.includes("\u0000") &&
    !value.includes("\n") &&
    !value.startsWith("/") &&
    !value.split("/").includes("..") &&
    !ignoredBasenames.has(basename) &&
    !ignoredPathPrefixes.some(
      (prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix),
    ) &&
    likelyTextExtensions.has(extension(value))
  );
};

const assertSnapshot = (snapshot: string): void => {
  if (!/^[0-9a-f]{7,64}$/u.test(snapshot)) {
    throw new Error(
      "repositorySnapshot must be a lowercase hexadecimal object ID",
    );
  }
};

const runGit = async (
  repository: string,
  args: readonly string[],
  maximumBytes = 16 * 1024 * 1024,
  allowedExitCodes: readonly number[] = [0],
): Promise<GitResult> => {
  try {
    const result = await execFileAsync("git", ["-C", repository, ...args], {
      encoding: "buffer",
      maxBuffer: maximumBytes,
      windowsHide: true,
    });
    return {
      stdout: result.stdout as Buffer,
      stderr: result.stderr as Buffer,
      exitCode: 0,
    };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: Buffer;
      stderr?: Buffer;
    };
    const exitCode =
      typeof candidate.code === "number" ? candidate.code : Number.NaN;
    if (allowedExitCodes.includes(exitCode)) {
      return {
        stdout: candidate.stdout ?? Buffer.alloc(0),
        stderr: candidate.stderr ?? Buffer.alloc(0),
        exitCode,
      };
    }
    throw new Error(
      `Bounded repository git operation failed: ${
        candidate instanceof Error ? candidate.message : String(error)
      }`,
    );
  }
};

const resolveSnapshot = async (
  repository: string,
  snapshot: string,
): Promise<{ commit: string; tree: string }> => {
  assertSnapshot(snapshot);
  const commit = (
    await runGit(repository, [
      "rev-parse",
      "--verify",
      `${snapshot}^{commit}`,
    ])
  ).stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit) || !commit.startsWith(snapshot)) {
    throw new Error(`Could not resolve exact repository snapshot ${snapshot}`);
  }
  const tree = (
    await runGit(repository, [
      "rev-parse",
      "--verify",
      `${commit}^{tree}`,
    ])
  ).stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(tree)) {
    throw new Error(`Could not resolve tree for repository snapshot ${commit}`);
  }
  return { commit, tree };
};

const repositoryPaths = async (
  repository: string,
  commit: string,
): Promise<string[]> => {
  const output = (
    await runGit(
      repository,
      ["ls-tree", "-r", "--name-only", "-z", commit],
      64 * 1024 * 1024,
    )
  ).stdout;
  return output
    .toString("utf8")
    .split("\u0000")
    .filter(Boolean)
    .filter(eligiblePath)
    .sort(lexicalCompare);
};

const queryTerms = (value: string, maximum = 12): string[] => [
  ...new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .split(/[^a-z0-9_./-]+/u)
      .flatMap((piece) => piece.split(/[./_-]+/u))
      .map((piece) => piece.trim())
      .filter(
        (piece) =>
          piece.length >= 3 &&
          piece.length <= 64 &&
          !stopWords.has(piece) &&
          !/^\d+$/u.test(piece),
      ),
  ),
].slice(0, maximum);

const taskAwareText = (episode: TaskEpisode): string =>
  [
    episode.taskAnchor,
    ...(episode.earlierUserContext ?? []),
    episode.precedingAssistant,
    episode.relevantDiagnostic,
    episode.currentRequest,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");

const parseArguments = (
  value: string | Record<string, unknown>,
): Record<string, unknown> => {
  if (typeof value !== "string") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("tool_arguments_invalid_json");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("tool_arguments_not_object");
  }
  return parsed as Record<string, unknown>;
};

const boundedString = (
  value: unknown,
  field: string,
  maximum: number,
): string => {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
};

const clip = (value: string, maximum: number): string =>
  value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 20))}\n…[output clipped]…`;

const occurrences = (value: string, term: string): number => {
  let count = 0;
  let offset = 0;
  while (count < 5) {
    const next = value.indexOf(term, offset);
    if (next < 0) break;
    count += 1;
    offset = next + term.length;
  }
  return count;
};

const bestLineForTerms = (
  lines: readonly string[],
  terms: readonly string[],
): number => {
  let bestLine = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = lines[index]!.toLowerCase();
    const score = terms.reduce(
      (sum, term) => sum + Math.min(3, occurrences(normalized, term)),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }
  return bestLine;
};

const lineNumberedExcerpt = (
  text: string,
  centerLine: number,
  maximumCharacters: number,
): { startLine: number; endLine: number; text: string } => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let start = Math.max(0, centerLine - 15);
  let end = Math.min(lines.length - 1, centerLine + 15);
  const render = (): string =>
    lines
      .slice(start, end + 1)
      .map(
        (line, offset) =>
          `${String(start + offset + 1).padStart(5, " ")} | ${line}`,
      )
      .join("\n");
  let rendered = render();
  while (rendered.length > maximumCharacters && start < end) {
    if (centerLine - start > end - centerLine) start += 1;
    else end -= 1;
    rendered = render();
  }
  return {
    startLine: start + 1,
    endLine: end + 1,
    text: clip(rendered, maximumCharacters),
  };
};

const validatePolicy = (
  policy: LunaBoundedRepositoryToolPolicy,
): void => {
  for (const [field, value, minimum, maximum] of [
    ["maximumSearchCalls", policy.maximumSearchCalls, 0, 4],
    ["maximumReadCalls", policy.maximumReadCalls, 1, 8],
    ["maximumSearchResults", policy.maximumSearchResults, 1, 32],
    [
      "maximumSearchOutputCharacters",
      policy.maximumSearchOutputCharacters,
      256,
      16_000,
    ],
    [
      "maximumReadOutputCharacters",
      policy.maximumReadOutputCharacters,
      256,
      16_000,
    ],
    [
      "maximumTotalToolOutputCharacters",
      policy.maximumTotalToolOutputCharacters,
      512,
      64_000,
    ],
    ["maximumFileBytes", policy.maximumFileBytes, 1_024, 4 * 1024 * 1024],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${field} must be an integer between ${minimum} and ${maximum}`,
      );
    }
  }
};

export const SEARCH_REPOSITORY_TOOL: OpenAiFunctionTool = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "search_repository",
    description:
      "Search the exact pre-task repository snapshot for a short, discriminating code or subsystem query. Returns at most eight repository-relative paths with one matching line each. Use one focused query, not a broad inventory request.",
    strict: true,
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "A focused search phrase or a few discriminating identifiers.",
        },
      },
    }),
  }),
});

export const READ_REPOSITORY_EXCERPT_TOOL: OpenAiFunctionTool = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "read_repository_excerpt",
    description:
      "Read one bounded, line-numbered excerpt from an allowed repository-relative path at the exact pre-task snapshot. The harness chooses the most task-relevant lines and never returns the full file.",
    strict: true,
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "A repository-relative path returned in the candidate list or by search_repository.",
        },
      },
    }),
  }),
});

export const createLunaBoundedRepositoryToolSession = async (input: {
  repository: string;
  episode: TaskEpisode;
  mode: LunaRepositoryAccessMode;
  candidatePaths?: readonly string[];
  policy?: LunaBoundedRepositoryToolPolicy;
}): Promise<LunaBoundedRepositoryToolSession> => {
  if (
    input.mode !== "candidate_read" &&
    input.mode !== "search_and_read"
  ) {
    throw new Error(`Unsupported repository access mode: ${input.mode}`);
  }
  const policy = {
    ...DEFAULT_LUNA_BOUNDED_REPOSITORY_TOOL_POLICY,
    ...(input.policy ?? {}),
  };
  validatePolicy(policy);
  if (input.mode === "candidate_read" && policy.maximumSearchCalls !== 0) {
    policy.maximumSearchCalls = 0;
  }
  const snapshot = await resolveSnapshot(
    input.repository,
    input.episode.repositorySnapshot,
  );
  const paths = await repositoryPaths(input.repository, snapshot.commit);
  const pathSet = new Set(paths);
  const candidatePaths = [
    ...new Set(input.candidatePaths ?? []),
  ].filter((value) => pathSet.has(value) && eligiblePath(value));
  if (input.mode === "candidate_read" && candidatePaths.length < 1) {
    throw new Error("candidate_read requires at least one valid candidate path");
  }

  const allowedReadPaths = new Set(candidatePaths);
  const taskTerms = queryTerms(taskAwareText(input.episode), 24);
  const accumulatedTerms = new Set(taskTerms);
  const readPaths = new Set<string>();
  const records: LunaRepositoryToolCallRecord[] = [];
  let searchCalls = 0;
  let readCalls = 0;
  let totalToolOutputCharacters = 0;

  const recordResult = (
    name: LunaRepositoryToolCallRecord["name"],
    args: Record<string, unknown>,
    content: string,
    resultPaths: string[],
    redactionsApplied: number,
    errorCode?: string,
  ): {
    content: string;
    record: LunaRepositoryToolCallRecord;
  } => {
    const remaining =
      policy.maximumTotalToolOutputCharacters - totalToolOutputCharacters;
    const boundedContent = clip(content, Math.max(0, remaining));
    totalToolOutputCharacters += boundedContent.length;
    const record: LunaRepositoryToolCallRecord = {
      index: records.length,
      name,
      arguments: args,
      ok: errorCode === undefined,
      outputCharacters: boundedContent.length,
      outputSha256: sha256(boundedContent),
      resultPaths: [...resultPaths],
      redactionsApplied,
      ...(errorCode ? { errorCode } : {}),
    };
    records.push(record);
    return { content: boundedContent, record };
  };

  const failure = (
    name: LunaRepositoryToolCallRecord["name"],
    args: Record<string, unknown>,
    code: string,
  ): {
    content: string;
    record: LunaRepositoryToolCallRecord;
  } =>
    recordResult(
      name,
      args,
      JSON.stringify({ ok: false, error: code }),
      [],
      0,
      code,
    );

  const executeSearch = async (
    args: Record<string, unknown>,
  ): Promise<{
    content: string;
    record: LunaRepositoryToolCallRecord;
  }> => {
    if (input.mode !== "search_and_read") {
      return failure("search_repository", args, "search_not_available");
    }
    if (searchCalls >= policy.maximumSearchCalls) {
      return failure("search_repository", args, "search_budget_exhausted");
    }
    searchCalls += 1;
    let query: string;
    try {
      query = boundedString(args.query, "query", 200);
    } catch {
      return failure("search_repository", args, "invalid_query");
    }
    const terms = queryTerms(query, 8);
    if (terms.length < 1) {
      return failure("search_repository", args, "query_has_no_search_terms");
    }
    terms.forEach((term) => accumulatedTerms.add(term));
    const grepArgs = [
      "grep",
      "-n",
      "-m",
      "3",
      "-I",
      "-i",
      "--full-name",
      ...terms.flatMap((term) => ["-e", term]),
      snapshot.commit,
      "--",
    ];
    const grep = await runGit(
      input.repository,
      grepArgs,
      128 * 1024 * 1024,
      [0, 1],
    );
    const byPath = new Map<
      string,
      {
        path: string;
        score: number;
        bestLineScore: number;
        matchedTerms: Set<string>;
        line: number;
        preview: string;
      }
    >();
    for (const rawLine of grep.stdout.toString("utf8").split(/\r?\n/u)) {
      if (!rawLine) continue;
      const matched =
        /^[0-9a-f]+:(.*?):([0-9]+):(.*)$/u.exec(rawLine);
      if (!matched) continue;
      const path = matched[1]!;
      const line = Number(matched[2]);
      const preview = matched[3]!.trim();
      if (!pathSet.has(path) || !eligiblePath(path) || !Number.isInteger(line)) {
        continue;
      }
      const normalizedPath = path.toLowerCase();
      const normalizedPreview = preview.toLowerCase();
      const matchedTerms = terms.filter(
        (term) =>
          normalizedPath.includes(term) || normalizedPreview.includes(term),
      );
      const lineScore = matchedTerms.reduce(
        (sum, term) =>
          sum +
          (normalizedPath.includes(term) ? 6 : 0) +
          Math.min(3, occurrences(normalizedPreview, term)),
        0,
      );
      const prior = byPath.get(path);
      if (!prior) {
        byPath.set(path, {
          path,
          score: lineScore,
          bestLineScore: lineScore,
          matchedTerms: new Set(matchedTerms),
          line,
          preview,
        });
      } else {
        matchedTerms.forEach((term) => prior.matchedTerms.add(term));
        prior.score += lineScore;
        if (lineScore > prior.bestLineScore) {
          prior.bestLineScore = lineScore;
          prior.line = line;
          prior.preview = preview;
        }
      }
    }
    const selected = [...byPath.values()]
      .map(
        (value): LunaRepositorySearchMatch => ({
          path: value.path,
          score: value.score + value.matchedTerms.size * 8,
          matchedTerms: [...value.matchedTerms].sort(lexicalCompare),
          line: value.line,
          preview: value.preview,
        }),
      )
      .sort(
        (left, right) =>
          right.score - left.score || lexicalCompare(left.path, right.path),
      )
      .slice(0, policy.maximumSearchResults);
    const renderedMatches = [...selected];
    let rendered = JSON.stringify({
      ok: true,
      query,
      matches: renderedMatches,
      resultLimit: policy.maximumSearchResults,
    });
    while (
      rendered.length > policy.maximumSearchOutputCharacters &&
      renderedMatches.length > 1
    ) {
      renderedMatches.pop();
      rendered = JSON.stringify({
        ok: true,
        query,
        matches: renderedMatches,
        resultLimit: policy.maximumSearchResults,
        clipped: true,
      });
    }
    const redacted = redactText(rendered);
    renderedMatches.forEach((match) => allowedReadPaths.add(match.path));
    return recordResult(
      "search_repository",
      args,
      redacted.text,
      renderedMatches.map((match) => match.path),
      redacted.redactions,
    );
  };

  const executeRead = async (
    args: Record<string, unknown>,
  ): Promise<{
    content: string;
    record: LunaRepositoryToolCallRecord;
  }> => {
    if (readCalls >= policy.maximumReadCalls) {
      return failure(
        "read_repository_excerpt",
        args,
        "read_budget_exhausted",
      );
    }
    let requestedPath: string;
    try {
      requestedPath = boundedString(args.path, "path", 500);
    } catch {
      return failure("read_repository_excerpt", args, "invalid_path");
    }
    if (
      !eligiblePath(requestedPath) ||
      !pathSet.has(requestedPath) ||
      (input.mode === "candidate_read" &&
        !allowedReadPaths.has(requestedPath))
    ) {
      return failure("read_repository_excerpt", args, "path_not_allowed");
    }
    if (readPaths.has(requestedPath)) {
      return failure(
        "read_repository_excerpt",
        args,
        "path_already_read",
      );
    }
    readCalls += 1;
    readPaths.add(requestedPath);
    const object = `${snapshot.commit}:${requestedPath}`;
    const sizeText = (
      await runGit(input.repository, ["cat-file", "-s", object])
    ).stdout.toString("utf8").trim();
    const size = Number(sizeText);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > policy.maximumFileBytes
    ) {
      return failure("read_repository_excerpt", args, "file_too_large");
    }
    const content = (
      await runGit(
        input.repository,
        ["show", object],
        policy.maximumFileBytes + 1024,
      )
    ).stdout.toString("utf8");
    const redacted = redactText(content.replaceAll("\r\n", "\n"));
    const terms = [...accumulatedTerms];
    const lines = redacted.text.split("\n");
    const centerLine = bestLineForTerms(lines, terms);
    const excerpt = lineNumberedExcerpt(
      redacted.text,
      centerLine,
      Math.max(256, policy.maximumReadOutputCharacters - 300),
    );
    const base = {
      ok: true,
      path: requestedPath,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
    };
    let excerptText = excerpt.text;
    let output = JSON.stringify({
      ...base,
      excerpt: excerptText,
    });
    while (
      output.length > policy.maximumReadOutputCharacters &&
      excerptText.length > 128
    ) {
      excerptText = `${excerptText.slice(
        0,
        Math.max(64, excerptText.length - 256),
      )}\n…[excerpt clipped]…`;
      output = JSON.stringify({
        ...base,
        excerpt: excerptText,
        clipped: true,
      });
    }
    return recordResult(
      "read_repository_excerpt",
      args,
      output,
      [requestedPath],
      redacted.redactions,
    );
  };

  return {
    mode: input.mode,
    candidatePaths,
    searchTool: SEARCH_REPOSITORY_TOOL,
    readTool: READ_REPOSITORY_EXCERPT_TOOL,
    execute: async (name, rawArguments) => {
      let args: Record<string, unknown>;
      try {
        args = parseArguments(rawArguments);
      } catch {
        return failure(
          name === "read_repository_excerpt"
            ? "read_repository_excerpt"
            : "search_repository",
          {},
          "invalid_arguments",
        );
      }
      if (name === "search_repository") return executeSearch(args);
      if (name === "read_repository_excerpt") return executeRead(args);
      return failure(
        "search_repository",
        args,
        "unknown_tool",
      );
    },
    summary: () => {
      const withoutHash = {
        schemaVersion: 1 as const,
        specificationVersion: LUNA_BOUNDED_REPOSITORY_TOOLS_VERSION,
        mode: input.mode,
        repositorySnapshot: snapshot.commit,
        repositorySnapshotTree: snapshot.tree,
        candidatePaths: [...candidatePaths],
        searchablePaths: paths.length,
        searchCalls,
        readCalls,
        toolOutputCharacters: totalToolOutputCharacters,
        toolCallRecords: [...records],
        allowedReadPaths: [...allowedReadPaths].sort(lexicalCompare),
        policy: { ...policy },
        safety: {
          exactPreTaskSnapshotOnly: true as const,
          workingTreeRead: false as const,
          postTaskDiffRead: false as const,
          labelsRead: false as const,
          predictionsRead: false as const,
          networkAccess: false as const,
          writesAllowed: false as const,
          arbitraryShellAllowed: false as const,
        },
      };
      return {
        ...withoutHash,
        sessionSha256: contentHash(withoutHash),
      };
    },
  };
};
