import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentHash, sha256 } from "./hash.js";
import { retrieveLunaRepositoryContext, } from "./luna-accuracy-repository-retrieval.js";
import { embedTexts } from "./openrouter.js";
import { redactText } from "./validation.js";
const execFileAsync = promisify(execFile);
export const LUNA_PERFORMANCE_RETRIEVAL_VERSION = "luna-performance-retrieval-v1";
export const LUNA_PERFORMANCE_EMBEDDING_MODEL = "voyageai/voyage-code-4";
export const LUNA_PERFORMANCE_RETRIEVAL_VARIANTS = [
    "lexical",
    "path_symbol",
    "bm25_embedding",
    "hybrid_rerank",
    "luna_query",
    "diverse_hybrid",
];
const MAXIMUM_FILE_BYTES = 512 * 1024;
const MAXIMUM_POOL_FILES = 96;
const MAXIMUM_EMBEDDING_CANDIDATES = 48;
const MAXIMUM_RETURNED_CANDIDATES = 12;
const LONG_SNIPPET_CHARACTERS = 1_240;
const STOP_WORDS = new Set([
    "a", "about", "add", "after", "all", "also", "an", "and", "any", "are",
    "as", "at", "be", "because", "before", "but", "by", "can", "change",
    "code", "could", "do", "does", "for", "from", "get", "have", "how", "i",
    "if", "implement", "in", "into", "is", "it", "its", "make", "may", "need",
    "not", "of", "on", "or", "please", "run", "should", "so", "some", "that",
    "the", "their", "then", "there", "this", "to", "up", "use", "want", "we",
    "what", "when", "where", "which", "will", "with", "would", "you", "your",
]);
const TEXT_EXTENSIONS = new Set([
    "", ".c", ".cc", ".conf", ".cpp", ".css", ".go", ".graphql", ".h", ".html",
    ".java", ".js", ".json", ".jsonc", ".jsx", ".md", ".mdx", ".mjs", ".mts",
    ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".tf", ".toml", ".ts",
    ".tsx", ".txt", ".yaml", ".yml",
]);
const SYMBOL_PATTERN = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|func|type|def)\s+([A-Za-z_$][\w$]*)[^\n]{0,220}/u;
const lexicalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const normalizeStem = (value) => {
    if (value.length > 5 && value.endsWith("ies")) {
        return `${value.slice(0, -3)}y`;
    }
    if (value.length > 5 && value.endsWith("ing"))
        return value.slice(0, -3);
    if (value.length > 4 && value.endsWith("ed"))
        return value.slice(0, -2);
    if (value.length > 4 && value.endsWith("es"))
        return value.slice(0, -2);
    if (value.length > 3 && value.endsWith("s"))
        return value.slice(0, -1);
    return value;
};
export const tokenizeLunaPerformanceRetrievalText = (text) => (text
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.:/+-]*/gu) ?? [])
    .flatMap((token) => token.split(/[^a-z0-9]+/u))
    .map(normalizeStem)
    .filter((token) => token.length >= 2 &&
    token.length <= 64 &&
    !STOP_WORDS.has(token) &&
    !/^\d+$/u.test(token));
const taskAwareText = (episode) => [
    episode.taskAnchor,
    ...(episode.earlierUserContext ?? []),
    episode.precedingAssistant,
    episode.relevantDiagnostic,
    episode.currentRequest,
]
    .filter((value) => Boolean(value?.trim()))
    .join("\n")
    .slice(-24_000);
const generatedQueryText = (generated) => generated
    ? [
        ...generated.searchQueries,
        ...generated.identifiers,
        ...generated.pathHints,
    ].join("\n")
    : "";
const extension = (filePath) => {
    const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
    const dot = basename.lastIndexOf(".");
    return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
};
const eligiblePath = (filePath, size) => size >= 0 &&
    size <= MAXIMUM_FILE_BYTES &&
    TEXT_EXTENSIONS.has(extension(filePath)) &&
    !filePath.startsWith("vendor/") &&
    !filePath.startsWith("node_modules/") &&
    !filePath.startsWith("dist/") &&
    !filePath.includes("/vendor/") &&
    !filePath.includes("/node_modules/") &&
    !/(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock)(?:$|\.)/u.test(filePath);
const runGit = async (repository, args, maxBuffer = 64 * 1024 * 1024) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const result = await execFileAsync("git", ["-C", repository, ...args], {
                encoding: "buffer",
                maxBuffer,
                windowsHide: true,
            });
            return result.stdout;
        }
        catch (error) {
            lastError = error;
            const detail = error instanceof Error ? error.message : String(error);
            const transient = /SSL connection timeout|could not fetch .* from promisor remote|RPC failed|remote end hung up|HTTP (?:408|429|5\d\d)/iu.test(detail);
            if (!transient || attempt === 2)
                break;
            await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
};
const snapshotTree = async (repository, snapshot, cache) => {
    const key = `${repository}:${snapshot}`;
    const cached = cache.get(key);
    if (cached)
        return cached;
    if (!/^[0-9a-f]{7,64}$/u.test(snapshot)) {
        throw new Error(`Unsafe repository snapshot: ${snapshot}`);
    }
    const resolved = (await runGit(repository, ["rev-parse", "--verify", `${snapshot}^{commit}`])).toString("utf8").trim();
    if (!resolved.startsWith(snapshot)) {
        throw new Error(`Snapshot mismatch: ${snapshot}`);
    }
    const output = await runGit(repository, [
        "ls-tree",
        "-r",
        "-z",
        "-l",
        "--full-tree",
        resolved,
    ]);
    const entries = output
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((row) => {
        const tab = row.indexOf("\t");
        if (tab < 0)
            throw new Error("Unparseable git tree row");
        const fields = row.slice(0, tab).trim().split(/\s+/u);
        return {
            path: row.slice(tab + 1),
            blob: fields[2],
            size: Number(fields[3]),
        };
    })
        .filter((entry) => eligiblePath(entry.path, entry.size))
        .sort((left, right) => lexicalCompare(left.path, right.path));
    cache.set(key, entries);
    return entries;
};
const readBlob = async (repository, blob, cache) => {
    const key = `${repository}:${blob}`;
    const cached = cache.get(key);
    if (cached !== undefined)
        return cached;
    const value = await runGit(repository, ["cat-file", "blob", blob], MAXIMUM_FILE_BYTES + 1024);
    if (value.includes(0)) {
        cache.set(key, "");
        return "";
    }
    const content = redactText(value.toString("utf8").replaceAll("\r\n", "\n")).text;
    cache.set(key, content);
    return content;
};
const countOccurrences = (values, term) => {
    let result = 0;
    for (const value of values)
        if (value === term)
            result += 1;
    return result;
};
const bestLineForTerms = (content, terms) => {
    const lines = content.split("\n");
    let bestLine = 0;
    let bestScore = -1;
    for (let index = 0; index < lines.length; index += 1) {
        const tokens = tokenizeLunaPerformanceRetrievalText(lines[index]);
        const score = tokens.reduce((sum, token) => sum + (terms.has(token) ? 1 : 0), 0);
        if (score > bestScore) {
            bestScore = score;
            bestLine = index;
        }
    }
    return bestLine;
};
const extractSymbols = (content, queryTerms, bestLine) => {
    const result = [];
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const signature = lines[index].trim();
        if (!SYMBOL_PATTERN.test(signature))
            continue;
        const matches = tokenizeLunaPerformanceRetrievalText(signature).filter((term) => queryTerms.has(term)).length;
        const distance = Math.abs(index - bestLine);
        const score = matches * 20 + Math.max(0, 10 - distance);
        if (score <= 0 && distance > 16)
            continue;
        result.push({
            signature: signature.slice(0, 260),
            score,
            line: index,
        });
    }
    return result
        .sort((left, right) => right.score - left.score ||
        left.line - right.line ||
        lexicalCompare(left.signature, right.signature))
        .slice(0, 4)
        .map((item) => item.signature);
};
const likelyAreas = (filePath, symbols, cards) => cards
    .map((card) => {
    let score = 0;
    for (const anchor of card.pathAnchors) {
        const prefix = anchor.replace(/\*.*$/u, "").replace(/\/$/u, "");
        if (prefix &&
            (filePath === prefix || filePath.startsWith(`${prefix}/`))) {
            score += 10;
        }
    }
    const symbolText = symbols.join(" ").toLowerCase();
    for (const anchor of card.symbolAnchors) {
        if (symbolText.includes(anchor.toLowerCase()))
            score += 6;
    }
    return { areaId: card.areaId, score };
})
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score ||
    lexicalCompare(left.areaId, right.areaId))
    .slice(0, 2)
    .map((item) => item.areaId);
const clipAroundLine = (content, lineIndex, maximumCharacters) => {
    const lines = content.split("\n");
    let start = Math.max(0, Math.min(lineIndex, lines.length - 1));
    let end = start;
    let text = lines[start] ?? "";
    while (true) {
        const previous = start > 0 ? lines[start - 1] : undefined;
        const next = end + 1 < lines.length ? lines[end + 1] : undefined;
        if (previous === undefined && next === undefined)
            break;
        const preferPrevious = previous !== undefined &&
            (next === undefined || lineIndex - start <= end - lineIndex);
        const candidate = preferPrevious
            ? `${previous}\n${text}`
            : `${text}\n${next ?? ""}`;
        if (candidate.length > maximumCharacters)
            break;
        if (preferPrevious)
            start -= 1;
        else
            end += 1;
        text = candidate;
    }
    if (text.length > maximumCharacters) {
        text = `${text.slice(0, maximumCharacters - 24).trimEnd()}\n…[snippet clipped]…`;
    }
    return { startLine: start + 1, endLine: end + 1, text };
};
const pathTermScore = (filePath, queryTerms) => {
    const pathTerms = new Set(tokenizeLunaPerformanceRetrievalText(filePath));
    const basenameTerms = new Set(tokenizeLunaPerformanceRetrievalText(filePath.slice(filePath.lastIndexOf("/") + 1)));
    return queryTerms.reduce((sum, term) => sum +
        (basenameTerms.has(term) ? 18 : pathTerms.has(term) ? 11 : 0), 0);
};
const normalizeRank = (candidates, score) => new Map([...candidates]
    .sort((left, right) => score(right) - score(left) ||
    lexicalCompare(left.path, right.path))
    .map((candidate, index) => [candidate.path, index + 1]));
const cosine = (left, right) => {
    if (left.length !== right.length || left.length === 0)
        return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] ** 2;
        rightNorm += right[index] ** 2;
    }
    return leftNorm > 0 && rightNorm > 0
        ? dot / Math.sqrt(leftNorm * rightNorm)
        : 0;
};
const cachedEmbeddings = async (model, cache, inputs, embed) => {
    const result = new Map();
    const missing = [];
    for (const input of inputs) {
        const found = await cache.get(model, input.id, input.text);
        if (found)
            result.set(input.id, found.values);
        else
            missing.push(input);
    }
    let usageTokens = 0;
    for (let offset = 0; offset < missing.length; offset += 32) {
        const batch = missing.slice(offset, offset + 32);
        const response = await embed(model, batch);
        usageTokens += response.usageTokens ?? 0;
        for (const vector of response.vectors) {
            const source = batch.find((item) => item.id === vector.id);
            if (!source)
                throw new Error(`Unexpected embedding ${vector.id}`);
            await cache.put(model, source.text, vector);
            result.set(vector.id, vector.values);
        }
    }
    return { vectors: result, usageTokens };
};
const baselineMatchMap = (matches) => new Map(matches.map((match) => [match.path, match]));
const representativeAreaPaths = (tree, cards, queryTerms) => {
    const result = [];
    for (const card of cards) {
        const candidates = tree
            .filter((entry) => card.pathAnchors.some((anchor) => {
            const prefix = anchor.replace(/\*.*$/u, "").replace(/\/$/u, "");
            return (prefix &&
                (entry.path === prefix || entry.path.startsWith(`${prefix}/`)));
        }))
            .sort((left, right) => pathTermScore(right.path, queryTerms) -
            pathTermScore(left.path, queryTerms) ||
            left.path.split("/").length - right.path.split("/").length ||
            lexicalCompare(left.path, right.path))
            .slice(0, 3);
        result.push(...candidates.map((entry) => entry.path));
    }
    return [...new Set(result)];
};
const bm25Scores = (candidates, queryTerms) => {
    const averageLength = candidates.reduce((sum, candidate) => sum + candidate.tokens.length, 0) /
        Math.max(1, candidates.length);
    const documentFrequency = new Map();
    for (const term of queryTerms) {
        documentFrequency.set(term, candidates.filter((candidate) => candidate.tokens.includes(term)).length);
    }
    const result = new Map();
    for (const candidate of candidates) {
        let score = 0;
        for (const term of queryTerms) {
            const frequency = countOccurrences(candidate.tokens, term);
            if (frequency === 0)
                continue;
            const documents = candidates.length;
            const present = documentFrequency.get(term) ?? 0;
            const idf = Math.log(1 + (documents - present + 0.5) / (present + 0.5));
            const k1 = 1.2;
            const b = 0.75;
            const denominator = frequency +
                k1 *
                    (1 -
                        b +
                        b * (candidate.tokens.length / Math.max(1, averageLength)));
            score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        result.set(candidate.path, score);
    }
    return result;
};
const candidateSimilarity = (left, right) => {
    const leftTerms = new Set(left.tokens.slice(0, 500));
    const rightTerms = new Set(right.tokens.slice(0, 500));
    const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length;
    const union = new Set([...leftTerms, ...rightTerms]).size;
    const lexical = union === 0 ? 0 : intersection / union;
    const leftDirectory = left.path.split("/").slice(0, 3).join("/");
    const rightDirectory = right.path.split("/").slice(0, 3).join("/");
    return Math.min(1, lexical + (leftDirectory === rightDirectory ? 0.35 : 0));
};
const diverseOrder = (ranked) => {
    const remaining = [...ranked];
    const selected = [];
    while (remaining.length > 0) {
        const maximumHybrid = Math.max(1e-9, ...remaining.map((candidate) => candidate.hybrid));
        const next = remaining
            .map((candidate) => {
            const redundancy = selected.length === 0
                ? 0
                : Math.max(...selected.map((chosen) => candidateSimilarity(candidate, chosen)));
            return {
                candidate,
                score: 0.78 * (candidate.hybrid / maximumHybrid) - 0.22 * redundancy,
            };
        })
            .sort((left, right) => right.score - left.score ||
            lexicalCompare(left.candidate.path, right.candidate.path))[0];
        next.candidate.hybrid = Math.max(next.candidate.hybrid, 0);
        selected.push(next.candidate);
        remaining.splice(remaining.indexOf(next.candidate), 1);
    }
    return selected;
};
const scoreReason = (variant, candidate) => {
    if (variant === "lexical") {
        return "Task terms and phrases matched this repository path or excerpt.";
    }
    if (variant === "path_symbol") {
        return "Repository path and nearby symbol signatures matched task identifiers.";
    }
    if (variant === "bm25_embedding") {
        return "BM25 lexical relevance and code-embedding similarity both favored this excerpt.";
    }
    if (variant === "luna_query") {
        return "A bounded Luna search-query rewrite led deterministic retrieval to this excerpt.";
    }
    if (variant === "diverse_hybrid") {
        return "Hybrid relevance was high and this excerpt added non-redundant repository evidence.";
    }
    return "Reciprocal-rank fusion combined lexical, path/symbol, BM25, and embedding evidence.";
};
const publicSnippet = (candidate, variant, diversityAdjusted) => {
    const clipped = clipAroundLine(candidate.content, candidate.bestLine, LONG_SNIPPET_CHARACTERS);
    return {
        path: candidate.path,
        startLine: clipped.startLine,
        endLine: clipped.endLine,
        text: clipped.text,
        symbols: candidate.symbols,
        likelyAreaIds: candidate.likelyAreaIds,
        retrievalReason: scoreReason(variant, candidate),
        scores: {
            lexical: candidate.lexical,
            pathSymbol: candidate.pathSymbol,
            bm25: candidate.bm25,
            embedding: candidate.embedding,
            hybrid: candidate.hybrid,
            diversityAdjusted,
        },
    };
};
export const retrieveLunaPerformanceEvidence = async (input) => {
    if (!LUNA_PERFORMANCE_RETRIEVAL_VARIANTS.includes(input.variant)) {
        throw new Error(`Unknown performance retrieval variant: ${input.variant}`);
    }
    if (input.variant === "luna_query" && !input.generatedQuery) {
        throw new Error("luna_query retrieval requires a generated query");
    }
    const queryText = [
        taskAwareText(input.episode),
        generatedQueryText(input.generatedQuery),
    ]
        .filter(Boolean)
        .join("\n");
    const queryTerms = [
        ...new Set(tokenizeLunaPerformanceRetrievalText(queryText)),
    ].slice(0, 128);
    const querySet = new Set(queryTerms);
    const augmentedEpisode = input.generatedQuery === undefined
        ? input.episode
        : {
            ...input.episode,
            relevantDiagnostic: [
                input.episode.relevantDiagnostic,
                "[BOUNDED GENERATED REPOSITORY SEARCH QUERY]",
                generatedQueryText(input.generatedQuery),
            ]
                .filter(Boolean)
                .join("\n"),
        };
    const baselineCache = input.context.baselineCache ??
        new Map();
    const baselineKey = contentHash({
        repository: input.repository,
        snapshot: input.episode.repositorySnapshot,
        taskAwareText: taskAwareText(augmentedEpisode),
        options: "paths_and_snippets/64000/64/1400",
    });
    let baseline = baselineCache.get(baselineKey);
    if (!baseline) {
        baseline = await retrieveLunaRepositoryContext({
            repository: input.repository,
            episode: augmentedEpisode,
            options: {
                mode: "paths_and_snippets",
                maximumCharacters: 64_000,
                maximumFiles: 64,
                maximumSnippetCharacters: 1_400,
            },
        });
        baselineCache.set(baselineKey, baseline);
    }
    const treeCache = input.context.treeCache ?? new Map();
    const blobCache = input.context.blobCache ?? new Map();
    const tree = await snapshotTree(input.repository, input.episode.repositorySnapshot, treeCache);
    const byPath = new Map(tree.map((entry) => [entry.path, entry]));
    const baselineByPath = baselineMatchMap(baseline.matches);
    const poolPaths = [
        ...baseline.matches.map((match) => match.path),
        ...representativeAreaPaths(tree, input.cards, queryTerms),
    ].slice(0, MAXIMUM_POOL_FILES);
    const candidates = [];
    for (const filePath of [...new Set(poolPaths)]) {
        const entry = byPath.get(filePath);
        if (!entry)
            continue;
        const content = await readBlob(input.repository, entry.blob, blobCache);
        if (!content)
            continue;
        const tokens = tokenizeLunaPerformanceRetrievalText(content.slice(0, 160_000));
        const bestLine = bestLineForTerms(content, querySet);
        const symbols = extractSymbols(content, querySet, bestLine);
        const baselineMatch = baselineByPath.get(filePath);
        const lexical = baselineMatch?.score ??
            queryTerms.reduce((sum, term) => sum + Math.min(4, countOccurrences(tokens, term)), 0);
        const matchedSymbols = symbols.reduce((sum, symbol) => sum +
            tokenizeLunaPerformanceRetrievalText(symbol).filter((term) => querySet.has(term)).length, 0);
        const pathSymbol = pathTermScore(filePath, queryTerms) +
            matchedSymbols * 20 +
            (symbols.length > 0 ? 3 : 0);
        candidates.push({
            path: filePath,
            blob: entry.blob,
            content,
            tokens,
            bestLine,
            symbols,
            likelyAreaIds: likelyAreas(filePath, symbols, input.cards),
            lexical,
            pathSymbol,
            bm25: 0,
            embedding: 0,
            hybrid: 0,
        });
    }
    const bm25 = bm25Scores(candidates, queryTerms);
    for (const candidate of candidates) {
        candidate.bm25 = bm25.get(candidate.path) ?? 0;
    }
    const embeddingCandidates = [...candidates]
        .sort((left, right) => right.bm25 - left.bm25 ||
        right.lexical - left.lexical ||
        lexicalCompare(left.path, right.path))
        .slice(0, MAXIMUM_EMBEDDING_CANDIDATES);
    const embeddingInputs = [
        {
            id: `query:${input.episode.id}:${sha256(queryText).slice(0, 12)}`,
            text: [
                "Retrieve implementation evidence for this coding task.",
                queryText,
            ].join("\n"),
        },
        ...embeddingCandidates.map((candidate) => {
            const snippet = clipAroundLine(candidate.content, candidate.bestLine, 3_200);
            return {
                id: `candidate:${candidate.blob}:${candidate.bestLine}`,
                text: [
                    `Repository path: ${candidate.path}`,
                    candidate.symbols.length
                        ? `Symbols:\n${candidate.symbols.join("\n")}`
                        : "",
                    `Source:\n${snippet.text}`,
                ]
                    .filter(Boolean)
                    .join("\n"),
            };
        }),
    ];
    const embeddings = await cachedEmbeddings(LUNA_PERFORMANCE_EMBEDDING_MODEL, input.context.embeddingCache, embeddingInputs, input.context.embed ?? embedTexts);
    const queryVector = embeddings.vectors.get(embeddingInputs[0].id);
    if (!queryVector)
        throw new Error("Missing retrieval query embedding");
    for (const [index, candidate] of embeddingCandidates.entries()) {
        const vector = embeddings.vectors.get(embeddingInputs[index + 1].id);
        if (!vector)
            throw new Error(`Missing candidate embedding ${candidate.path}`);
        candidate.embedding = cosine(queryVector, vector);
    }
    const lexicalRanks = normalizeRank(candidates, (item) => item.lexical);
    const pathRanks = normalizeRank(candidates, (item) => item.pathSymbol);
    const bm25EmbeddingRanks = normalizeRank(candidates, (item) => item.bm25 + Math.max(0, item.embedding) * 8);
    for (const candidate of candidates) {
        candidate.hybrid =
            1 / (60 + (lexicalRanks.get(candidate.path) ?? candidates.length)) +
                1 / (60 + (pathRanks.get(candidate.path) ?? candidates.length)) +
                1 /
                    (60 +
                        (bm25EmbeddingRanks.get(candidate.path) ?? candidates.length)) +
                candidate.likelyAreaIds.length * 0.0005;
    }
    const order = input.variant === "lexical"
        ? [...candidates].sort((left, right) => right.lexical - left.lexical ||
            lexicalCompare(left.path, right.path))
        : input.variant === "path_symbol"
            ? [...candidates].sort((left, right) => right.pathSymbol - left.pathSymbol ||
                right.lexical - left.lexical ||
                lexicalCompare(left.path, right.path))
            : input.variant === "bm25_embedding"
                ? [...candidates].sort((left, right) => right.bm25 +
                    Math.max(0, right.embedding) * 8 -
                    (left.bm25 + Math.max(0, left.embedding) * 8) ||
                    lexicalCompare(left.path, right.path))
                : input.variant === "diverse_hybrid"
                    ? diverseOrder([...candidates].sort((left, right) => right.hybrid - left.hybrid ||
                        lexicalCompare(left.path, right.path)))
                    : [...candidates].sort((left, right) => right.hybrid - left.hybrid ||
                        lexicalCompare(left.path, right.path));
    const publicCandidates = order
        .slice(0, MAXIMUM_RETURNED_CANDIDATES)
        .map((candidate, index) => publicSnippet(candidate, input.variant, input.variant === "diverse_hybrid"
        ? 1 / (index + 1)
        : candidate.hybrid));
    const selected = publicCandidates.slice(0, 8);
    const binding = {
        taskEpisodeId: input.episode.id,
        repositorySnapshot: input.episode.repositorySnapshot,
        variant: input.variant,
        querySha256: sha256(queryText),
        candidates: publicCandidates,
    };
    return {
        schemaVersion: 1,
        specificationVersion: LUNA_PERFORMANCE_RETRIEVAL_VERSION,
        taskEpisodeId: input.episode.id,
        repositoryId: input.episode.repositoryId,
        repositorySnapshot: input.episode.repositorySnapshot,
        variant: input.variant,
        querySource: input.generatedQuery
            ? "task_aware_context_plus_luna_query"
            : "task_aware_context",
        ...(input.generatedQuery
            ? { generatedQuery: input.generatedQuery }
            : {}),
        candidates: publicCandidates,
        selected,
        safeguards: {
            exactPreTaskSnapshot: true,
            taskAwareContextOnly: true,
            labelsReadDuringRetrieval: false,
            changedPathsRead: false,
            postTaskDiffRead: false,
        },
        provenance: {
            candidatePoolSize: candidates.length,
            selectedFiles: selected.length,
            querySha256: sha256(queryText),
            resultSha256: contentHash(binding),
            embeddingModel: LUNA_PERFORMANCE_EMBEDDING_MODEL,
            embeddingInputTokens: embeddings.usageTokens,
        },
    };
};
export const lunaPerformancePathMatches = (candidate, relevant) => {
    const left = candidate.replace(/\/+$/u, "");
    const right = relevant.replace(/\/+$/u, "");
    return (left === right ||
        left.startsWith(`${right}/`) ||
        right.startsWith(`${left}/`));
};
export const evaluateLunaPerformanceRetrieval = (input) => {
    const labels = new Map(input.labels.map((label) => [label.taskEpisodeId, label]));
    let eligibleCases = 0;
    let any4 = 0;
    let any8 = 0;
    let recall4 = 0;
    let recall8 = 0;
    let reciprocal = 0;
    for (const result of input.results) {
        const label = labels.get(result.taskEpisodeId);
        if (!label)
            throw new Error(`Missing retrieval label ${result.taskEpisodeId}`);
        if (label.relevantPaths.length === 0)
            continue;
        eligibleCases += 1;
        const recallAt = (limit) => label.relevantPaths.filter((relevant) => result.candidates
            .slice(0, limit)
            .some((candidate) => lunaPerformancePathMatches(candidate.path, relevant))).length / label.relevantPaths.length;
        const at4 = recallAt(4);
        const at8 = recallAt(8);
        recall4 += at4;
        recall8 += at8;
        if (at4 > 0)
            any4 += 1;
        if (at8 > 0)
            any8 += 1;
        const rank = result.candidates.findIndex((candidate) => label.relevantPaths.some((relevant) => lunaPerformancePathMatches(candidate.path, relevant)));
        if (rank >= 0)
            reciprocal += 1 / (rank + 1);
    }
    return {
        cases: input.results.length,
        eligibleCases,
        anyRelevantPathAt4: eligibleCases === 0 ? 0 : any4 / eligibleCases,
        anyRelevantPathAt8: eligibleCases === 0 ? 0 : any8 / eligibleCases,
        meanRelevantPathRecallAt4: eligibleCases === 0 ? 0 : recall4 / eligibleCases,
        meanRelevantPathRecallAt8: eligibleCases === 0 ? 0 : recall8 / eligibleCases,
        meanReciprocalRelevantPathRank: eligibleCases === 0 ? 0 : reciprocal / eligibleCases,
    };
};
