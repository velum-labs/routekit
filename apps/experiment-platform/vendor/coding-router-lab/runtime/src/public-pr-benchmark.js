import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { contentHash, sha256 } from "./hash.js";
import { redactText } from "./validation.js";
const execFileAsync = promisify(execFile);
export const PUBLIC_PR_BENCHMARK_VERSION = "public-pr-benchmark-backstage-v1";
export const PUBLIC_PR_ISSUE_GROUNDED_VERSION = "public-pr-benchmark-backstage-issue-grounded-v2";
export const BACKSTAGE_PRIMARY_AREAS = [
    {
        areaId: "catalog",
        name: "Software catalog and entity ingestion",
        githubLabels: ["area:catalog"],
        description: "Catalog entities, locations, providers, processors, relations, entity pages, ingestion, querying, and catalog backend behavior.",
        inclusions: [
            "Catalog entity ingestion and processing",
            "Catalog providers, processors, relations, and locations",
            "Catalog API and entity-page behavior",
        ],
        exclusions: [
            "Creating software from templates",
            "Searching across indexed content",
            "Authentication and permission policy",
        ],
        confusableAreaIds: ["scaffolder", "search", "auth", "permission"],
        pathAnchors: ["plugins/catalog", "plugins/catalog-*", "packages/catalog-*"],
        componentAnchors: ["catalog backend", "catalog frontend", "entity model"],
        symbolAnchors: ["CatalogService", "Entity", "EntityProvider"],
        boundaryExamples: [
            "Changing entity ingestion belongs to catalog; creating a component from a template belongs to scaffolder.",
            "Changing catalog ownership relations belongs to catalog; evaluating whether a user may read an entity belongs to permission.",
        ],
    },
    {
        areaId: "auth",
        name: "Authentication and identity",
        githubLabels: ["area:auth"],
        description: "Sign-in, identity resolution, OAuth providers, sessions, tokens, authentication services, and authenticated user identity.",
        inclusions: [
            "OAuth and identity providers",
            "Sign-in resolvers and sessions",
            "User identity and authentication tokens",
        ],
        exclusions: [
            "Authorization policy and permission rules",
            "Catalog ownership modeling without authentication behavior",
        ],
        confusableAreaIds: ["permission", "catalog"],
        pathAnchors: ["plugins/auth", "plugins/auth-*", "docs/auth"],
        componentAnchors: ["auth backend", "identity API", "OAuth providers"],
        symbolAnchors: ["IdentityApi", "AuthService", "signInResolver"],
        boundaryExamples: [
            "Determining who the user is belongs to auth; deciding what that user may do belongs to permission.",
        ],
    },
    {
        areaId: "permission",
        name: "Permissions and authorization policy",
        githubLabels: ["area:permission"],
        description: "Permission policies, rules, conditional decisions, authorization metadata, permission clients, and access-control enforcement.",
        inclusions: [
            "Permission policy evaluation",
            "Permission rules and conditions",
            "Authorization clients and metadata",
        ],
        exclusions: [
            "OAuth login and identity-provider behavior",
            "Catalog ingestion unrelated to access control",
        ],
        confusableAreaIds: ["auth", "catalog"],
        pathAnchors: ["plugins/permission-*", "docs/permissions"],
        componentAnchors: ["permission backend", "permission node", "policy"],
        symbolAnchors: ["PermissionPolicy", "PermissionRule", "AuthorizeResult"],
        boundaryExamples: [
            "Changing an OAuth refresh flow belongs to auth; changing an authorization rule belongs to permission.",
        ],
    },
    {
        areaId: "scaffolder",
        name: "Software templates and scaffolder",
        githubLabels: ["area:scaffolder"],
        description: "Software templates, scaffolder actions, task execution, template forms, field extensions, and generated-project workflows.",
        inclusions: [
            "Template authoring and execution",
            "Scaffolder actions and task workers",
            "Template form fields and created-component workflows",
        ],
        exclusions: [
            "Catalog ingestion after creation",
            "General backend framework behavior",
        ],
        confusableAreaIds: ["catalog", "events"],
        pathAnchors: ["plugins/scaffolder", "plugins/scaffolder-*"],
        componentAnchors: ["scaffolder backend", "template editor", "task broker"],
        symbolAnchors: ["TemplateAction", "TaskBroker", "ScaffolderApi"],
        boundaryExamples: [
            "Generating a new component belongs to scaffolder; ingesting the resulting entity belongs to catalog.",
        ],
    },
    {
        areaId: "techdocs",
        name: "TechDocs generation and rendering",
        githubLabels: ["area:techdocs"],
        description: "TechDocs generation, storage, publishing, rendering, navigation, readers, builders, and documentation-site integration.",
        inclusions: [
            "TechDocs build and publishing pipelines",
            "TechDocs reader and navigation UI",
            "TechDocs storage and generators",
        ],
        exclusions: [
            "The backstage.io microsite and general repository documentation",
            "Search infrastructure except TechDocs-specific integration",
        ],
        confusableAreaIds: ["search"],
        pathAnchors: ["plugins/techdocs", "plugins/techdocs-*", "packages/techdocs-*"],
        componentAnchors: ["TechDocs backend", "TechDocs reader", "documentation generator"],
        symbolAnchors: ["TechDocsReaderPage", "TechdocsGenerator", "Publisher"],
        boundaryExamples: [
            "Rendering a TechDocs page belongs to TechDocs; indexing that page for global search belongs to search.",
        ],
    },
    {
        areaId: "search",
        name: "Search and discoverability",
        githubLabels: ["area:search", "area:discoverability"],
        description: "Search indexing, collators, query APIs, search result presentation, search engines, and cross-plugin discoverability.",
        inclusions: [
            "Search indexing and collators",
            "Search query APIs and engines",
            "Search result UI and ranking",
        ],
        exclusions: [
            "Catalog query behavior that is not search indexing",
            "TechDocs rendering outside its search collator",
        ],
        confusableAreaIds: ["catalog", "techdocs", "scaffolder"],
        pathAnchors: ["plugins/search", "plugins/search-*", "docs/features/search"],
        componentAnchors: ["search backend", "search frontend", "collators"],
        symbolAnchors: ["SearchEngine", "SearchQuery", "Collator"],
        boundaryExamples: [
            "Indexing catalog entities belongs to search; changing catalog entity storage belongs to catalog.",
        ],
    },
    {
        areaId: "kubernetes",
        name: "Kubernetes feature integration",
        githubLabels: ["area:kubernetes"],
        description: "Backstage's Kubernetes plugin, cluster discovery, object fetching, proxying, frontend resources, and Kubernetes-specific configuration.",
        inclusions: [
            "Kubernetes cluster discovery and clients",
            "Kubernetes resource presentation",
            "Kubernetes proxy and backend behavior",
        ],
        exclusions: [
            "Deploying Backstage itself to Kubernetes",
            "Generic catalog behavior without Kubernetes integration",
        ],
        confusableAreaIds: ["catalog", "auth", "permission"],
        pathAnchors: ["plugins/kubernetes", "plugins/kubernetes-*"],
        componentAnchors: ["Kubernetes backend", "Kubernetes frontend", "cluster supplier"],
        symbolAnchors: ["KubernetesBuilder", "KubernetesApi", "ClusterSupplier"],
        boundaryExamples: [
            "Displaying workloads from a cluster belongs to Kubernetes; deploying the Backstage server belongs to operations rather than this area.",
        ],
    },
    {
        areaId: "events",
        name: "Events and event delivery",
        githubLabels: ["area:events"],
        description: "Event routing, brokers, topics, event ingestion, event subscribers, and integrations that publish or consume Backstage events.",
        inclusions: [
            "Event broker and routing behavior",
            "Event subscribers and publishers",
            "External event ingestion",
        ],
        exclusions: [
            "User-facing notifications and signals",
            "Scaffolder task execution without event infrastructure changes",
        ],
        confusableAreaIds: ["scaffolder", "catalog"],
        pathAnchors: ["plugins/events-*", "beps/0003-events"],
        componentAnchors: ["events backend", "event broker", "event router"],
        symbolAnchors: ["EventsService", "EventBroker", "EventSubscriber"],
        boundaryExamples: [
            "Transporting an event belongs to events; rendering a notification to a user belongs to notifications.",
        ],
    },
];
export const BACKSTAGE_NATURAL_UNKNOWN_GROUPS = [
    {
        id: "notifications",
        labels: ["area:notifications"],
    },
    {
        id: "core-framework",
        labels: ["area:core", "area:framework"],
    },
    {
        id: "documentation-site",
        labels: ["area:documentation", "area:microsite"],
    },
    {
        id: "tooling-design-operations",
        labels: [
            "area:tooling",
            "area:operations",
            "area:openapi-tooling",
            "area:design-system",
            "area:storybook",
            "area:auditor",
        ],
    },
    {
        id: "home",
        labels: ["area:home"],
    },
];
export const BACKSTAGE_NATURAL_UNKNOWN_LABELS = BACKSTAGE_NATURAL_UNKNOWN_GROUPS.flatMap((group) => group.labels);
const stopHeading = /^(?:#{1,6}\s*)?(?:what changed|changes?|implementation|solution|the fix|fix|testing|tests?|verification|checklist|screenshots?|before|after|surface area|files changed|release notes?|risk assessment)\s*:?\s*$/iu;
const boilerplateLine = /^(?:##\s+Hey,? .*(?:Pull Request|MR)!?|<!--.*|[-*]\s*\[[ xX]\]\s+|####?\s*:heavy_check_mark:\s*Checklist)/u;
export const extractPublicPrProblemStatement = (body, maximumCharacters = 3_000) => {
    const withoutComments = body
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
        .replace(/<img\b[^>]*>/giu, "")
        .replaceAll("\r\n", "\n");
    const prioritySections = [];
    const headingPattern = /^(#{1,6})\s+(problem|why|context|motivation|background|existing behavio(?:u)?r|expected behavio(?:u)?r)\s*:?\s*$/gimu;
    const headings = [...withoutComments.matchAll(headingPattern)];
    for (const [index, heading] of headings.entries()) {
        const start = (heading.index ?? 0) + heading[0].length;
        const nextHeading = /^#{1,6}\s+.+$/gmu;
        nextHeading.lastIndex = start;
        const next = nextHeading.exec(withoutComments);
        const end = next?.index ?? withoutComments.length;
        const section = withoutComments.slice(start, end).trim();
        if (section)
            prioritySections.push(section);
        if (index >= 3)
            break;
    }
    const source = prioritySections.length > 0
        ? prioritySections.join("\n\n")
        : withoutComments;
    const kept = [];
    for (const rawLine of source.split("\n")) {
        const line = rawLine.trimEnd();
        if (stopHeading.test(line.trim()))
            break;
        if (boilerplateLine.test(line.trim()))
            continue;
        if (/^[-*]\s*\[[ xX]\]/u.test(line.trim()))
            continue;
        kept.push(line);
    }
    const compact = kept
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
    if (!compact)
        return "";
    return compact.length <= maximumCharacters
        ? compact
        : `${compact.slice(0, Math.max(0, maximumCharacters - 24)).trimEnd()}\n…[context clipped]…`;
};
export const buildPublicPrTaskText = (title, body) => {
    const cleanedTitle = redactText(title).text.trim();
    const problem = redactText(extractPublicPrProblemStatement(body)).text.trim();
    if (!problem || problem === cleanedTitle) {
        return { taskText: cleanedTitle, source: "title_only" };
    }
    return {
        taskText: `${cleanedTitle}\n\nProblem context:\n${problem}`,
        source: "title_and_problem_statement",
    };
};
const normalizeIssueHeading = (heading) => heading
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
export const extractPublicIssueProblemStatement = (body, maximumCharacters = 3_000) => {
    const cleaned = body
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
        .replace(/<img\b[^>]*>/giu, "")
        .replaceAll("\r\n", "\n");
    const headingMatches = [
        ...cleaned.matchAll(/^(#{1,6})\s+(.+?)\s*$/gmu),
    ];
    if (headingMatches.length === 0) {
        return extractPublicPrProblemStatement(cleaned, maximumCharacters);
    }
    const included = [];
    const preamble = cleaned.slice(0, headingMatches[0]?.index ?? 0).trim();
    if (preamble)
        included.push(preamble);
    const includeHeading = /^(?:description(?: (?:and )?context)?|context|provide the context for the bug|need|summary|what happened|what is wrong|what s wrong|what is the chore|what s the chore|what would you like to be added|why is this needed|expected behavior|what did you expect to happen|actual behavior(?: with screenshots)?|reproduction steps?|how can we reproduce it(?: as minimally and precisely as possible)?|use case|impact|problem|problem statement|background|motivation)$/u;
    const excludeHeading = /^(?:issue labels|search terms|project area|external integration|proposal|proposed solution|solution|solution options|root cause|implementation|details|alternatives|anything else we need to know|environment|your environment|kubernetes version|grafana version|browser|os version|cloud provider|install tools|container runtime(?: cri)? and version(?: if applicable)?|related plugins(?: cni csi)? and versions(?: if applicable)?|reproduction repo|have you read the code of conduct|are you willing to submit pr|checklist)$/u;
    for (const [index, match] of headingMatches.entries()) {
        const heading = normalizeIssueHeading(match[2] ?? "");
        const start = (match.index ?? 0) + match[0].length;
        const end = headingMatches[index + 1]?.index ?? cleaned.length;
        const section = cleaned.slice(start, end).trim();
        if (!section || excludeHeading.test(heading))
            continue;
        if (includeHeading.test(heading)) {
            included.push(section);
        }
    }
    const compact = included
        .join("\n\n")
        .replace(/^_No response_$/gimu, "")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
    const fallback = compact || extractPublicPrProblemStatement(cleaned);
    return fallback.length <= maximumCharacters
        ? fallback
        : `${fallback.slice(0, Math.max(0, maximumCharacters - 24)).trimEnd()}\n…[context clipped]…`;
};
export const buildPublicIssueTaskText = (title, body) => {
    const cleanedTitle = redactText(title).text.trim();
    const problem = redactText(extractPublicIssueProblemStatement(body)).text.trim();
    if (!problem || problem === cleanedTitle)
        return cleanedTitle;
    return `${cleanedTitle}\n\nProblem context:\n${problem}`;
};
export const extractBackstageIssueNumbersFromPullBody = (body) => {
    const numbers = new Set();
    const add = (raw) => {
        const value = Number(raw);
        if (Number.isSafeInteger(value) && value > 0)
            numbers.add(value);
    };
    for (const match of body.matchAll(/https?:\/\/github\.com\/backstage\/backstage\/issues\/(\d+)/giu)) {
        add(match[1]);
    }
    for (const match of body.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|address(?:e[sd])?|issue|ref(?:erence)?s?)\s*:?\s*#(\d+)/giu)) {
        add(match[1]);
    }
    return [...numbers].sort((left, right) => left - right);
};
const excludedCandidate = (candidate) => {
    const login = candidate.authorLogin.toLowerCase();
    if (login.includes("bot") || login.includes("dependabot"))
        return true;
    if (candidate.labels.includes("dependencies"))
        return true;
    if (candidate.samplingKind === "natural_unknown" &&
        candidate.labels.some((label) => BACKSTAGE_PRIMARY_AREAS.some((area) => area.githubLabels.includes(label)))) {
        return true;
    }
    if (/(?:^|\b)(?:version packages|build\(deps\)|deps:|dependency update|release(?:\s|:)|bump(?:\s|:))/iu.test(candidate.title.trim()) ||
        /(?:^|\n)See \[docs\/releases\/.*changelog\.md\]/iu.test(candidate.body) ||
        /^(?:patch release|updated?\s+`?@?[^ ]+`?\s+to\s+`?v?\d|(?:upgrade|update)\b.*\bto\s+(?:latest|`?v?\d)|.*(?:duplicate|unused)\s+(?:dependency|dependencies)\b)/iu.test(candidate.title.trim()) ||
        /^[\w@./-]+:\s*[^\p{L}\p{N}]*$/u.test(candidate.title.trim())) {
        return true;
    }
    return (candidate.changedFiles < 1 ||
        candidate.changedFiles > 40 ||
        candidate.title.trim().length < 12 ||
        !candidate.mergeCommitOid ||
        !candidate.mergedAt);
};
const qualityScore = (candidate) => {
    const bodyLength = candidate.body.trim().length;
    let score = 0;
    if (bodyLength >= 200 && bodyLength <= 8_000)
        score += 5;
    else if (bodyLength > 0)
        score += 2;
    if (/^(?:feat|fix|refactor|perf|test)(?:\([^)]+\))?!?:/iu.test(candidate.title)) {
        score += 2;
    }
    if (candidate.changedFiles <= 12)
        score += 2;
    if (candidate.changedFiles <= 5)
        score += 1;
    if (candidate.labels.filter((label) => label.startsWith("area:")).length > 1) {
        score += 1;
    }
    if (candidate.samplingKind === "known") {
        const primaryLabels = new Set(BACKSTAGE_PRIMARY_AREAS.flatMap((area) => area.githubLabels));
        const knownAreaLabels = candidate.labels.filter((label) => primaryLabels.has(label));
        const unknownAreaLabels = candidate.labels.filter((label) => BACKSTAGE_NATURAL_UNKNOWN_LABELS.includes(label));
        if (knownAreaLabels.length === 1 && unknownAreaLabels.length === 0) {
            score += 4;
        }
        else if (unknownAreaLabels.length > 0) {
            score -= 3;
        }
    }
    return score;
};
export const selectBalancedPublicPrCandidates = (input) => {
    const selected = new Map();
    const eligible = input.candidates.filter((candidate) => !excludedCandidate(candidate));
    for (const area of BACKSTAGE_PRIMARY_AREAS) {
        const candidates = eligible
            .filter((candidate) => candidate.samplingKind === "known" &&
            candidate.samplingAreaId === area.areaId)
            .sort((left, right) => qualityScore(right) - qualityScore(left) ||
            left.mergedAt.localeCompare(right.mergedAt) ||
            left.number - right.number);
        const spread = [...candidates].sort((left, right) => left.mergedAt.localeCompare(right.mergedAt) ||
            left.number - right.number);
        const available = spread.filter((candidate) => !selected.has(candidate.number));
        if (available.length < input.perKnownArea) {
            throw new Error(`Not enough distinct eligible public PRs for ${area.areaId}: ${available.length}`);
        }
        for (let index = 0; index < input.perKnownArea; index += 1) {
            const start = Math.floor((index * available.length) / input.perKnownArea);
            const end = Math.max(start + 1, Math.floor(((index + 1) * available.length) / input.perKnownArea));
            const candidate = available
                .slice(start, end)
                .sort((left, right) => qualityScore(right) - qualityScore(left) ||
                right.mergedAt.localeCompare(left.mergedAt) ||
                right.number - left.number)[0];
            selected.set(candidate.number, candidate);
        }
    }
    const unknownGroups = new Map();
    for (const candidate of eligible) {
        if (candidate.samplingKind !== "natural_unknown" ||
            selected.has(candidate.number)) {
            continue;
        }
        const group = unknownGroups.get(candidate.samplingAreaId) ?? [];
        group.push(candidate);
        unknownGroups.set(candidate.samplingAreaId, group);
    }
    for (const group of unknownGroups.values()) {
        group.sort((left, right) => qualityScore(right) - qualityScore(left) ||
            left.mergedAt.localeCompare(right.mergedAt) ||
            left.number - right.number);
    }
    const groupIds = [...unknownGroups.keys()].sort();
    let cursor = 0;
    while (selected.size <
        BACKSTAGE_PRIMARY_AREAS.length * input.perKnownArea +
            input.naturalUnknowns &&
        groupIds.length > 0) {
        const groupId = groupIds[cursor % groupIds.length];
        const group = unknownGroups.get(groupId);
        const candidate = group.shift();
        if (!candidate) {
            groupIds.splice(cursor % groupIds.length, 1);
            continue;
        }
        if (!selected.has(candidate.number))
            selected.set(candidate.number, candidate);
        cursor += 1;
    }
    const expected = BACKSTAGE_PRIMARY_AREAS.length * input.perKnownArea +
        input.naturalUnknowns;
    if (selected.size < expected) {
        throw new Error(`Could select only ${selected.size} unique public PRs; expected ${expected}`);
    }
    return [...selected.values()].sort((left, right) => left.mergedAt.localeCompare(right.mergedAt) ||
        left.number - right.number);
};
export const assignPublicPrSplits = (candidates) => {
    const groups = new Map();
    for (const candidate of candidates) {
        const key = candidate.samplingAreaId;
        const group = groups.get(key) ?? [];
        group.push(candidate);
        groups.set(key, group);
    }
    const result = new Map();
    for (const group of groups.values()) {
        group.sort((left, right) => left.mergedAt.localeCompare(right.mergedAt) ||
            left.number - right.number);
        for (const [index, candidate] of group.entries()) {
            const fraction = index / Math.max(1, group.length);
            result.set(candidate.number, fraction < 0.5
                ? "reference"
                : fraction < 0.75
                    ? "validation"
                    : "test");
        }
    }
    return result;
};
const sleep = async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
};
const ghJson = async (args) => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            const result = await execFileAsync("gh", [...args], {
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
            });
            return JSON.parse(result.stdout);
        }
        catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            if (attempt >= 3 ||
                !/(?:HTTP 5\d\d|502 Bad Gateway|timeout|connection reset|stream error|received from peer|\bCANCEL\b)/iu.test(message)) {
                throw error;
            }
            await sleep(1_000 * 2 ** attempt);
        }
    }
    throw lastError;
};
const collectLabelCandidates = async (input) => {
    const pulls = await ghJson([
        "pr",
        "list",
        "-R",
        input.repository,
        "--state",
        "merged",
        "--search",
        `label:${input.label} ${input.linkedIssueOnly ? "linked:issue " : ""}merged:>=2024-01-01`,
        "--limit",
        String(input.limit),
        "--json",
        "number,title,body,mergedAt,mergeCommit,labels,author,changedFiles,additions,deletions,url",
    ]);
    return pulls.map((pull) => ({
        number: pull.number,
        title: pull.title,
        body: pull.body ?? "",
        mergedAt: pull.mergedAt,
        mergeCommitOid: pull.mergeCommit?.oid ?? "",
        labels: pull.labels.map((label) => label.name).sort(),
        authorLogin: pull.author?.login ?? "unknown",
        changedFiles: pull.changedFiles,
        additions: pull.additions,
        deletions: pull.deletions,
        url: pull.url,
        samplingAreaId: input.samplingAreaId,
        samplingKind: input.samplingKind,
    }));
};
const issueFromRest = async (repository, issueNumber) => {
    try {
        const issue = await ghJson([
            "api",
            `repos/${repository}/issues/${issueNumber}`,
        ]);
        if (issue.pull_request)
            return undefined;
        return {
            number: issue.number,
            title: issue.title,
            body: issue.body ?? "",
            url: issue.html_url,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/(?:HTTP 404|Not Found)/iu.test(message))
            return undefined;
        throw error;
    }
};
const linkedIssueForPull = async (repository, candidate) => {
    const [owner, name] = repository.split("/");
    if (!owner || !name)
        throw new Error(`Invalid GitHub repository ${repository}`);
    const result = await ghJson([
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:10){nodes{number title body url}} timelineItems(first:100,itemTypes:[CONNECTED_EVENT,CROSS_REFERENCED_EVENT]){nodes{__typename ... on ConnectedEvent{subject{__typename ... on Issue{number title body url}}} ... on CrossReferencedEvent{source{__typename ... on Issue{number title body url}}}}}}}}",
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${candidate.number}`,
    ]);
    const pull = result.data.repository?.pullRequest;
    if (!pull)
        return undefined;
    const ranked = new Map();
    const offer = (issue, method, rank) => {
        if (!issue || issue.number === candidate.number)
            return;
        const existing = ranked.get(issue.number);
        if (!existing || rank < existing.rank) {
            ranked.set(issue.number, { issue, method, rank });
        }
    };
    for (const issue of pull.closingIssuesReferences.nodes) {
        offer(issue, "closing_reference", 0);
    }
    for (const event of pull.timelineItems.nodes) {
        if (event.__typename === "ConnectedEvent") {
            offer(event.subject, "connected_event", 1);
        }
        else if (event.__typename === "CrossReferencedEvent" &&
            event.source.__typename === "Issue") {
            offer(event.source, "cross_reference", 3);
        }
    }
    for (const issueNumber of extractBackstageIssueNumbersFromPullBody(candidate.body)) {
        if (ranked.has(issueNumber))
            continue;
        offer(await issueFromRest(repository, issueNumber), "explicit_body_reference", 2);
    }
    const candidates = [...ranked.values()].sort((left, right) => left.rank - right.rank ||
        right.issue.body.trim().length - left.issue.body.trim().length ||
        left.issue.number - right.issue.number);
    const selected = candidates[0];
    if (!selected)
        return undefined;
    return {
        ...selected.issue,
        resolutionMethod: selected.method,
        candidateCount: candidates.filter((candidate) => candidate.rank === selected.rank).length,
    };
};
const materializeCandidate = async (repository, candidate, split) => {
    const commit = await ghJson([
        "api",
        `repos/${repository}/git/commits/${candidate.mergeCommitOid}`,
    ]);
    const preTaskSnapshot = commit.parents[0]?.sha;
    if (!preTaskSnapshot) {
        throw new Error(`PR ${candidate.number} merge commit has no parent`);
    }
    const files = await ghJson([
        "api",
        "--paginate",
        `repos/${repository}/pulls/${candidate.number}/files?per_page=100`,
    ]);
    const issue = await linkedIssueForPull(repository, candidate);
    const task = issue
        ? {
            taskText: buildPublicIssueTaskText(issue.title, issue.body),
            source: "linked_issue",
        }
        : buildPublicPrTaskText(candidate.title, candidate.body);
    return {
        ...candidate,
        preTaskSnapshot,
        actualChangedPaths: files.map((file) => file.filename).sort(),
        taskTextSource: task.source,
        taskText: task.taskText,
        ...(issue
            ? {
                linkedIssue: {
                    number: issue.number,
                    url: issue.url,
                    resolutionMethod: issue.resolutionMethod,
                    candidateCount: issue.candidateCount,
                },
            }
            : {}),
        split,
    };
};
export const auditPublicPrToolOpportunity = (candidate) => {
    const task = candidate.taskText;
    const directRegisteredAreaCues = BACKSTAGE_PRIMARY_AREAS.filter((area) => {
        const terms = [
            area.areaId,
            area.name,
            ...area.githubLabels.map((label) => label.replace(/^area:/u, "")),
            ...area.componentAnchors,
        ];
        return terms.some((term) => {
            const normalized = term
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, "[\\\\s_./:@-]*");
            return new RegExp(`(?:^|[^\\\\p{L}\\\\p{N}])${normalized}(?:$|[^\\\\p{L}\\\\p{N}])`, "iu").test(task);
        });
    }).map((area) => area.areaId);
    const hasRepositoryLocatorCue = /https?:\/\/github\.com\/backstage\/backstage\/blob\//iu.test(task) ||
        /(?:^|[\s`(])(?:packages|plugins|docs|beps|app|src|test)\/[\w./*-]+/iu.test(task) ||
        /@backstage\/plugin-[\w-]+/iu.test(task);
    const opportunity = directRegisteredAreaCues.length > 0
        ? "low"
        : hasRepositoryLocatorCue
            ? "medium"
            : "high";
    return {
        taskEpisodeId: `backstage-pr-${candidate.number}`,
        split: candidate.split,
        samplingAreaId: candidate.samplingAreaId,
        directRegisteredAreaCues,
        hasRepositoryLocatorCue,
        opportunity,
        rationale: opportunity === "high"
            ? "No registered-area name or exact repository locator appears in the runtime task; bounded exploration has a real chance to add information."
            : opportunity === "medium"
                ? "The task omits a direct registered-area name but already contains a path, package, or source locator."
                : "The runtime task directly names at least one registered area or component, so tool exploration may be redundant for top-1 classification.",
    };
};
export const auditPublicPrTaskQuality = (candidate) => {
    const flags = [];
    const task = candidate.taskText.trim();
    if (!candidate.linkedIssue) {
        flags.push({
            code: "missing-linked-issue",
            severity: "critical",
            detail: "No repository issue could be resolved for this pull request.",
        });
    }
    if (task.length < 60) {
        flags.push({
            code: "short-task",
            severity: task.length < 30 ? "critical" : "warning",
            detail: `Runtime task has only ${task.length} characters.`,
        });
    }
    if (!task.includes("\n\nProblem context:\n")) {
        flags.push({
            code: "title-only",
            severity: "warning",
            detail: "The linked issue yielded no usable problem/context body.",
        });
    }
    if (/(?:^|\n)(?:#{1,6}\s*)?(?:implementation|proposed solution|solution|the fix|changes?|files changed)\s*:?\s*(?:\n|$)/iu.test(task) ||
        /\b(?:implemented|this change (?:adds|updates|removes)|we changed|the fix is to)\b/iu.test(task)) {
        flags.push({
            code: "possible-implementation-detail",
            severity: "warning",
            detail: "Task text may contain a proposed or completed implementation rather than only the problem.",
        });
    }
    if (/(?:^|[\s`(])(?:packages|plugins|docs|beps|app|src|test)\/[\w./*-]+/iu.test(task) ||
        /\b[A-Z][A-Za-z0-9]+(?:Service|Api|Provider|Router|Page|Client|Builder)\b/u.test(task)) {
        flags.push({
            code: "path-or-symbol-clue",
            severity: "note",
            detail: "Task contains a path or symbol-like clue; audit whether it is natural issue context or answer leakage.",
        });
    }
    if ((candidate.linkedIssue?.candidateCount ?? 0) > 1) {
        flags.push({
            code: "ambiguous-linked-issues",
            severity: "warning",
            detail: `The PR was associated with ${candidate.linkedIssue.candidateCount} possible issues; the strongest relation was selected.`,
        });
    }
    if (/\b(?:backport|cherry[- ]pick)\b/iu.test(candidate.title)) {
        flags.push({
            code: "backport-or-cherry-pick",
            severity: "critical",
            detail: "Backports and cherry-picks are not independent task lineages.",
        });
    }
    return {
        taskEpisodeId: `backstage-pr-${candidate.number}`,
        pullRequestNumber: candidate.number,
        split: candidate.split,
        samplingAreaId: candidate.samplingAreaId,
        taskTextSource: candidate.taskTextSource,
        taskCharacters: task.length,
        ...(candidate.linkedIssue
            ? { linkedIssueNumber: candidate.linkedIssue.number }
            : {}),
        flags,
        automaticDisposition: flags.some((flag) => flag.severity === "critical")
            ? "reject"
            : flags.some((flag) => flag.severity === "warning")
                ? "manual-review"
                : "accept",
    };
};
const deduplicateIssueLineages = (candidates) => {
    const selected = new Map();
    for (const candidate of candidates) {
        const key = candidate.linkedIssue
            ? `issue:${candidate.linkedIssue.number}`
            : `pr:${candidate.number}`;
        const previous = selected.get(key);
        if (!previous ||
            qualityScore(candidate) > qualityScore(previous) ||
            (qualityScore(candidate) === qualityScore(previous) &&
                candidate.mergedAt.localeCompare(previous.mergedAt) < 0)) {
            selected.set(key, candidate);
        }
    }
    return [...selected.values()];
};
const renderTaskQualityAudit = (audits) => {
    const evaluated = audits.filter((audit) => audit.split === "validation" || audit.split === "test");
    const rows = evaluated.map((audit) => {
        const flags = audit.flags.length === 0
            ? "none"
            : audit.flags
                .map((flag) => `${flag.severity}:${flag.code}`)
                .join(", ");
        return `| ${audit.taskEpisodeId} | ${audit.split} | ${audit.samplingAreaId} | ${audit.linkedIssueNumber ?? "none"} | ${audit.taskCharacters} | ${audit.automaticDisposition} | ${flags} |`;
    });
    return [
        "# Backstage public benchmark task-quality audit",
        "",
        "This is deterministic triage, not a substitute for a human review. Review every validation/test warning before the paid Sol freeze.",
        "",
        `Evaluated validation/test tasks: ${evaluated.length}`,
        `Automatic accepts: ${evaluated.filter((audit) => audit.automaticDisposition === "accept").length}`,
        `Manual reviews: ${evaluated.filter((audit) => audit.automaticDisposition === "manual-review").length}`,
        `Automatic rejects: ${evaluated.filter((audit) => audit.automaticDisposition === "reject").length}`,
        "",
        "| Episode | Split | Sampling stratum | Linked issue | Characters | Disposition | Flags |",
        "|---|---|---|---:|---:|---|---|",
        ...rows,
        "",
    ].join("\n");
};
const renderToolOpportunityAudit = (audits) => {
    const evaluated = audits.filter((audit) => audit.split === "validation" || audit.split === "test");
    return [
        "# Backstage repository-tool opportunity audit",
        "",
        "This report prevents an easy benchmark from hiding a useful tool effect. The primary accuracy result still uses every frozen task; the repository-tool treatment effect is also reported on the predeclared high-opportunity subset.",
        "",
        `Validation/test tasks: ${evaluated.length}`,
        `High opportunity: ${evaluated.filter((audit) => audit.opportunity === "high").length}`,
        `Medium opportunity: ${evaluated.filter((audit) => audit.opportunity === "medium").length}`,
        `Low opportunity: ${evaluated.filter((audit) => audit.opportunity === "low").length}`,
        "",
        "| Episode | Split | Sampling stratum | Opportunity | Direct area cues | Repository locator |",
        "|---|---|---|---|---|---|",
        ...evaluated.map((audit) => `| ${audit.taskEpisodeId} | ${audit.split} | ${audit.samplingAreaId} | ${audit.opportunity} | ${audit.directRegisteredAreaCues.join(", ") || "none"} | ${audit.hasRepositoryLocatorCue ? "yes" : "no"} |`),
        "",
    ].join("\n");
};
const areaCards = () => BACKSTAGE_PRIMARY_AREAS.map((area) => {
    return {
        schemaVersion: 1,
        registryVersion: "backstage-public-project-areas-v1",
        repositoryId: "backstage/backstage",
        areaId: area.areaId,
        name: area.name,
        description: area.description,
        inclusions: [...area.inclusions],
        exclusions: [...area.exclusions],
        confusableAreaIds: [...area.confusableAreaIds],
        pathAnchors: [...area.pathAnchors],
        componentAnchors: [...area.componentAnchors],
        symbolAnchors: [...area.symbolAnchors],
        codeSummaries: [],
        codeSnippets: [],
        positiveExampleIds: [],
        boundaryExamples: [...area.boundaryExamples],
        sourceHashes: [
            contentHash({
                version: PUBLIC_PR_BENCHMARK_VERSION,
                areaId: area.areaId,
                githubLabels: area.githubLabels,
            }),
        ],
        generatorVersion: PUBLIC_PR_BENCHMARK_VERSION,
    };
});
export const collectBackstagePublicPrBenchmark = async (input) => {
    const repository = "backstage/backstage";
    const perKnownArea = input.perKnownArea ?? 12;
    const naturalUnknowns = input.naturalUnknowns ?? 18;
    const candidateLimit = input.candidateLimitPerLabel ?? 100;
    const issueGroundedOnly = input.issueGroundedOnly ?? false;
    const pools = [];
    for (const area of BACKSTAGE_PRIMARY_AREAS) {
        for (const label of area.githubLabels) {
            pools.push(...(await collectLabelCandidates({
                repository,
                label,
                samplingAreaId: area.areaId,
                samplingKind: "known",
                limit: candidateLimit,
                linkedIssueOnly: issueGroundedOnly,
            })));
        }
    }
    for (const group of BACKSTAGE_NATURAL_UNKNOWN_GROUPS) {
        for (const label of group.labels) {
            pools.push(...(await collectLabelCandidates({
                repository,
                label,
                samplingAreaId: group.id,
                samplingKind: "natural_unknown",
                limit: candidateLimit,
                linkedIssueOnly: issueGroundedOnly,
            })));
        }
    }
    // Some Backstage areas (notably permission) have only a handful of eligible
    // merged PRs with linked issues. Do not require an artificial oversampling
    // quota that is larger than the final per-area target.
    const oversampleKnown = perKnownArea;
    const oversampleUnknowns = issueGroundedOnly
        ? naturalUnknowns + 4
        : naturalUnknowns;
    const initialCandidates = selectBalancedPublicPrCandidates({
        candidates: pools,
        perKnownArea: oversampleKnown,
        naturalUnknowns: oversampleUnknowns,
    });
    const initiallyMaterialized = [];
    for (const candidate of initialCandidates) {
        initiallyMaterialized.push(await materializeCandidate(repository, candidate, "reference"));
    }
    let materialized;
    if (issueGroundedOnly) {
        const resolved = deduplicateIssueLineages(initiallyMaterialized.filter((candidate) => candidate.linkedIssue));
        const finalCandidates = selectBalancedPublicPrCandidates({
            candidates: resolved,
            perKnownArea,
            naturalUnknowns,
        });
        const finalNumbers = new Set(finalCandidates.map((candidate) => candidate.number));
        const finalSplits = assignPublicPrSplits(finalCandidates);
        materialized = resolved
            .filter((candidate) => finalNumbers.has(candidate.number))
            .map((candidate) => ({
            ...candidate,
            split: finalSplits.get(candidate.number) ?? "test",
        }))
            .sort((left, right) => left.mergedAt.localeCompare(right.mergedAt) ||
            left.number - right.number);
    }
    else {
        const splits = assignPublicPrSplits(initialCandidates);
        materialized = initiallyMaterialized.map((candidate) => ({
            ...candidate,
            split: splits.get(candidate.number) ?? "test",
        }));
    }
    const episodes = materialized.map((candidate) => ({
        schemaVersion: 1,
        id: `backstage-pr-${candidate.number}`,
        repositoryId: repository,
        repositorySnapshot: candidate.preTaskSnapshot,
        sessionHash: contentHash(`github:${repository}:pr:${candidate.number}`),
        lineageHash: contentHash(`github:${repository}:pr:${candidate.number}`),
        timestamp: new Date(candidate.mergedAt).toISOString(),
        split: candidate.split,
        currentRequest: candidate.taskText,
        source: "github",
    }));
    const cards = areaCards();
    const latestSnapshot = materialized
        .map((candidate) => candidate.preTaskSnapshot)
        .at(-1);
    const profile = {
        schemaVersion: 1,
        repositoryId: repository,
        snapshot: latestSnapshot,
        name: "Backstage",
        purpose: "An open-source framework for building developer portals, with a plugin architecture spanning catalog, identity, authorization, templates, documentation, search, Kubernetes, events, and notifications.",
        languages: ["TypeScript", "MDX", "JavaScript", "CSS"],
        frameworks: ["Node.js", "React", "Yarn workspaces", "Backstage plugin system"],
        components: BACKSTAGE_PRIMARY_AREAS.map((area) => ({
            name: area.name,
            purpose: area.description,
            paths: [...area.pathAnchors],
        })),
        generatorVersion: PUBLIC_PR_BENCHMARK_VERSION,
    };
    const offlineEvidence = materialized.map((candidate) => ({
        schemaVersion: 1,
        taskEpisodeId: `backstage-pr-${candidate.number}`,
        pullRequestNumber: candidate.number,
        pullRequestUrl: candidate.url,
        mergeCommit: candidate.mergeCommitOid,
        preTaskSnapshot: candidate.preTaskSnapshot,
        githubAreaLabels: candidate.labels.filter((label) => label.startsWith("area:")),
        samplingAreaId: candidate.samplingAreaId,
        samplingKind: candidate.samplingKind,
        actualChangedPaths: candidate.actualChangedPaths,
        taskTextSource: candidate.taskTextSource,
        ...(candidate.linkedIssue
            ? { linkedIssue: { ...candidate.linkedIssue } }
            : {}),
        policy: "Offline sampling and audit evidence only. Never provide GitHub labels, changed paths, merge commits, or post-task diffs to Sol or Luna.",
    }));
    const countsBySplit = Object.fromEntries(["reference", "validation", "test"].map((split) => [
        split,
        episodes.filter((episode) => episode.split === split).length,
    ]));
    const countsByArea = Object.fromEntries(BACKSTAGE_PRIMARY_AREAS.map((area) => [
        area.areaId,
        materialized.filter((candidate) => candidate.samplingKind === "known" &&
            candidate.samplingAreaId === area.areaId).length,
    ]));
    const outputDirectory = path.resolve(input.outputDirectory);
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const writeJson = async (name, value) => {
        await writeFile(path.join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    };
    const writeJsonl = async (name, values) => {
        await writeFile(path.join(outputDirectory, name), `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, { mode: 0o600 });
    };
    await writeJson("repository-profile.json", profile);
    await writeJsonl("area-cards.jsonl", cards);
    await writeJsonl("episodes.jsonl", episodes);
    await writeJsonl("offline-evidence.jsonl", offlineEvidence);
    const taskQualityAudits = materialized.map(auditPublicPrTaskQuality);
    await writeJson("task-quality-audit.json", {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        policy: "Deterministic triage only. Every validation/test warning requires manual review before paid labeling.",
        counts: {
            total: taskQualityAudits.length,
            accept: taskQualityAudits.filter((audit) => audit.automaticDisposition === "accept").length,
            manualReview: taskQualityAudits.filter((audit) => audit.automaticDisposition === "manual-review").length,
            reject: taskQualityAudits.filter((audit) => audit.automaticDisposition === "reject").length,
        },
        audits: taskQualityAudits,
    });
    await writeFile(path.join(outputDirectory, "task-quality-audit.md"), renderTaskQualityAudit(taskQualityAudits), { mode: 0o600 });
    const toolOpportunityAudits = materialized.map(auditPublicPrToolOpportunity);
    await writeJson("tool-opportunity-audit.json", {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        policy: "Primary metrics use the full frozen set. Repository-tool treatment effects are additionally reported on the predeclared high-opportunity validation subset.",
        counts: {
            total: toolOpportunityAudits.length,
            high: toolOpportunityAudits.filter((audit) => audit.opportunity === "high").length,
            medium: toolOpportunityAudits.filter((audit) => audit.opportunity === "medium").length,
            low: toolOpportunityAudits.filter((audit) => audit.opportunity === "low").length,
        },
        audits: toolOpportunityAudits,
    });
    await writeFile(path.join(outputDirectory, "tool-opportunity-audit.md"), renderToolOpportunityAudit(toolOpportunityAudits), { mode: 0o600 });
    const specificationVersion = issueGroundedOnly
        ? PUBLIC_PR_ISSUE_GROUNDED_VERSION
        : PUBLIC_PR_BENCHMARK_VERSION;
    await writeJson("manifest.json", {
        schemaVersion: 1,
        specificationVersion,
        generatedAt: new Date().toISOString(),
        repository,
        counts: {
            total: episodes.length,
            bySplit: countsBySplit,
            byArea: countsByArea,
            naturalUnknown: materialized.filter((candidate) => candidate.samplingKind === "natural_unknown").length,
            taskTextSources: {
                linkedIssue: materialized.filter((candidate) => candidate.taskTextSource === "linked_issue").length,
                titleOnly: materialized.filter((candidate) => candidate.taskTextSource === "title_only").length,
                titleAndProblemStatement: materialized.filter((candidate) => candidate.taskTextSource === "title_and_problem_statement").length,
            },
            linkedIssueResolutionMethods: Object.fromEntries([
                "closing_reference",
                "connected_event",
                "explicit_body_reference",
                "cross_reference",
            ].map((method) => [
                method,
                materialized.filter((candidate) => candidate.linkedIssue?.resolutionMethod === method).length,
            ])),
        },
        leakagePolicy: {
            runtimeEpisodesContainGithubLabels: false,
            runtimeEpisodesContainChangedPaths: false,
            runtimeEpisodesContainMergeCommit: false,
            oracleMayReadExactPreTaskSnapshot: true,
            offlineEvidenceMayBeJoinedOnlyAfterPredictionsFreeze: true,
        },
        hashes: {
            profile: contentHash(profile),
            cards: contentHash(cards),
            episodes: contentHash(episodes),
            offlineEvidence: contentHash(offlineEvidence),
            taskQualityAudit: contentHash(taskQualityAudits),
            toolOpportunityAudit: contentHash(toolOpportunityAudits),
            episodeFileSha256: sha256(`${episodes.map((episode) => JSON.stringify(episode)).join("\n")}\n`),
        },
        warnings: [
            "Public PR tasks are external coding evidence, not personalized-user traffic.",
            "GitHub project-area labels and changed paths are sampling and audit metadata, not gold labels.",
            "PR descriptions are deterministically truncated before implementation/testing sections where recognizable; the task-text source must still be manually audited before paid labeling.",
            "The latest chronological split is locked test data and must not select prompts, taxonomy boundaries, retrieval, or tool policy.",
            ...(issueGroundedOnly
                ? [
                    "Every runtime task is reconstructed from a linked issue; linked-issue relation metadata remains offline.",
                ]
                : []),
        ],
    });
};
