import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { contentHash, sha256 } from "./hash.ts";
import {
  buildPublicIssueTaskText,
  extractPublicIssueProblemStatement,
  type PublicPrAreaDefinition,
} from "./public-pr-benchmark.ts";
import type {
  AreaCardV1,
  RepositoryProfileV1,
  Split,
  TaskEpisodeV1,
  TaskEpisodeV2,
} from "./types.ts";

const execFileAsync = promisify(execFile);

export const CONVERSATIONAL_COHORT_VERSION =
  "real-conversational-coding-v1" as const;
export const DIVERSE_PUBLIC_COHORT_VERSION =
  "diverse-public-issue-grounded-v1" as const;
export const NATURAL_HARD_COHORT_VERSION =
  "natural-hard-cohort-v1" as const;

const writeJson = async (
  directory: string,
  name: string,
  value: unknown,
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
};

const writeJsonl = async (
  directory: string,
  name: string,
  values: readonly unknown[],
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized =
    values.length === 0
      ? ""
      : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await writeFile(path.join(directory, name), serialized, { mode: 0o600 });
};

const readJsonl = async <T>(file: string): Promise<T[]> => {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
};

const normalizeText = (text: string): string =>
  text.replace(/\s+/gu, " ").trim().toLowerCase();

interface ConversationalSource {
  engineerPseudonym: "alen" | "benjamin";
  file: string;
}

export const DEFAULT_CONVERSATIONAL_SOURCES: readonly ConversationalSource[] = [
  {
    engineerPseudonym: "alen",
    file: "data/private/team-transfers-20260815/imported/000alen-velum-labs-routekit-combined-20260815/000alen-velum-labs-routekit-combined-20260815-source-episodes.jsonl",
  },
  {
    engineerPseudonym: "alen",
    file: "data/private/team-transfers-20260815/imported/000alen-velum-labs-factory-combined-20260815/000alen-velum-labs-factory-combined-20260815-source-episodes.jsonl",
  },
  {
    engineerPseudonym: "alen",
    file: "data/private/team-transfers-20260815/imported/000alen-velum-labs-ori-20260815/000alen-velum-labs-ori-20260815-aws-recurated-final-episodes.jsonl",
  },
  {
    engineerPseudonym: "benjamin",
    file: "data/private/team-transfers-20260815/imported/benjamzc-velum-labs-routekit-20260815/benjamzc-velum-labs-routekit-20260815-aws-recurated-final-episodes.jsonl",
  },
  {
    engineerPseudonym: "benjamin",
    file: "data/private/team-transfers-20260815/imported/benjamzc-velum-labs-velum-20260815/benjamzc-velum-labs-velum-20260815-aws-recurated-final-episodes.jsonl",
  },
] as const;

type ConversationStratum =
  | "debugging_followup"
  | "short_referential"
  | "implementation_followup"
  | "incomplete_specification";

interface ConversationalCandidate {
  engineerPseudonym: "alen" | "benjamin";
  sourceFile: string;
  episode: TaskEpisodeV2;
  stratum: ConversationStratum;
  score: number;
}

const hasManagedContext = (episode: TaskEpisodeV2): boolean =>
  Boolean(
    episode.taskAnchor ||
      episode.precedingAssistant ||
      episode.earlierUserContext?.length ||
      episode.relevantDiagnostic,
  );

const codingSignal =
  /\b(?:implement|implementation|fix|bug|test|typecheck|lint|ci|error|fail(?:ed|ing|ure)?|debug|code|refactor|build|command|cli|api|daemon|gateway|provider|typescript|javascript|python|golang|rust|function|class|method|package|repo(?:sitory)?|commit|branch|pull request|\bpr\b|deploy|docker|auth|token|route|config|schema|runtime|server|frontend|backend|component|migration|install|release|workflow|docs?|readme|dependency|environment|vercel|fumadocs)\b/iu;

const excludedConversationalTopic =
  /\b(?:minecraft|skin|x algorithm|twitter algorithm|notion|gtm|go[- ]to[- ]market|sales prospect|fundrais|dating|restaurant|vacation|yc says|keeping close contact with people for feedback|today we.?re launching routekit|launch announcement|social media|x account|website skill|linear spec doc)\b/iu;

const classifyConversation = (
  episode: TaskEpisodeV2,
): ConversationStratum => {
  const request = episode.currentRequest.trim();
  const combined = [
    request,
    episode.taskAnchor ?? "",
    episode.precedingAssistant ?? "",
    ...(episode.earlierUserContext ?? []),
    episode.relevantDiagnostic ?? "",
  ].join("\n");
  if (
    episode.relevantDiagnostic ||
    /\b(?:ci|test|build|typecheck|lint|deploy(?:ment)?)\b.{0,30}\b(?:fail|error|broken)\b|\b(?:fix it|fix them|can you fix|migrate and fix)\b/isu.test(
      combined,
    )
  ) {
    return "debugging_followup";
  }
  if (
    /\b(?:please implement this plan|implement this|create a pr|commit|push|hotfix)\b/iu.test(
      request,
    )
  ) {
    return "implementation_followup";
  }
  if (
    request.length <= 100 ||
    /^(?:continue|continue!|go ahead|do it|proceed|done|fix it|fix them|remove that|add this)\b/iu.test(
      request,
    )
  ) {
    return "short_referential";
  }
  return "incomplete_specification";
};

const conversationScore = (episode: TaskEpisodeV2): number => {
  const request = episode.currentRequest.trim();
  let score = 0;
  if (episode.taskAnchor) score += 4;
  if (episode.precedingAssistant) score += 4;
  if (episode.earlierUserContext?.length) score += 3;
  if (episode.relevantDiagnostic) score += 6;
  if (episode.provenance.context.isReferentialRequest) score += 4;
  if (request.length >= 10 && request.length <= 180) score += 5;
  else if (request.length <= 1_200) score += 3;
  if (/\b(?:fix|implement|test|debug|refactor|migrate|build|ci)\b/iu.test(request)) {
    score += 4;
  }
  if (/^(?:continue|done|go ahead|proceed)!?$/iu.test(request)) score -= 2;
  return score;
};

const assignChronologicalSplits = <T extends { timestamp: string }>(
  values: readonly T[],
): Map<T, Split> => {
  const sorted = [...values].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  const result = new Map<T, Split>();
  for (const [index, value] of sorted.entries()) {
    const fraction = index / Math.max(1, sorted.length);
    result.set(
      value,
      fraction < 0.5
        ? "reference"
        : fraction < 0.75
          ? "validation"
          : "test",
    );
  }
  return result;
};

const selectConversationalCandidates = (
  candidates: readonly ConversationalCandidate[],
  target: number,
): ConversationalCandidate[] => {
  const independentByLineage = new Map<string, ConversationalCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.engineerPseudonym}:${candidate.episode.lineageHash}`;
    const existing = independentByLineage.get(key);
    if (
      !existing ||
      candidate.score > existing.score ||
      (candidate.score === existing.score &&
        candidate.episode.timestamp.localeCompare(
          existing.episode.timestamp,
        ) < 0)
    ) {
      independentByLineage.set(key, candidate);
    }
  }
  const independentCandidates = [...independentByLineage.values()];
  const availableByEngineer = new Map(
    (["alen", "benjamin"] as const).map((engineer) => {
      const sessions = new Map<string, number>();
      for (const candidate of independentCandidates) {
        if (candidate.engineerPseudonym !== engineer) continue;
        sessions.set(
          candidate.episode.sessionHash,
          (sessions.get(candidate.episode.sessionHash) ?? 0) + 1,
        );
      }
      return [
        engineer,
        [...sessions.values()].reduce(
          (sum, count) => sum + Math.min(2, count),
          0,
        ),
      ];
    }),
  );
  const effectiveTarget = Math.min(
    target,
    availableByEngineer.get("alen")! +
      availableByEngineer.get("benjamin")!,
  );
  if (effectiveTarget < 40) {
    throw new Error(
      `Only ${effectiveTarget} quality-gated conversational coding tasks are available; need at least 40`,
    );
  }
  const minimumMinorityShare = Math.min(
    15,
    availableByEngineer.get("benjamin")!,
  );
  const benjaminQuota = Math.min(
    Math.floor(effectiveTarget / 2),
    availableByEngineer.get("benjamin")!,
  );
  const desiredBenjamin = Math.max(minimumMinorityShare, benjaminQuota);
  const desiredAlen = Math.min(
    availableByEngineer.get("alen")!,
    effectiveTarget - desiredBenjamin,
  );
  const perEngineer = new Map([
    ["alen", desiredAlen],
    ["benjamin", effectiveTarget - desiredAlen],
  ] as const);
  const selected: ConversationalCandidate[] = [];
  const selectedIds = new Set<string>();
  const perSession = new Map<string, number>();
  const strataOrder: readonly ConversationStratum[] = [
    "debugging_followup",
    "short_referential",
    "implementation_followup",
    "incomplete_specification",
  ];
  for (const engineer of ["alen", "benjamin"] as const) {
    const quota = perEngineer.get(engineer)!;
    const pool = independentCandidates
      .filter((candidate) => candidate.engineerPseudonym === engineer)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.episode.timestamp.localeCompare(right.episode.timestamp) ||
          left.episode.id.localeCompare(right.episode.id),
      );
    let cursor = 0;
    while (
      selected.filter(
        (candidate) => candidate.engineerPseudonym === engineer,
      ).length < quota
    ) {
      const stratum = strataOrder[cursor % strataOrder.length]!;
      const candidate = pool.find(
        (item) =>
          item.stratum === stratum &&
          !selectedIds.has(item.episode.id) &&
          (perSession.get(item.episode.sessionHash) ?? 0) < 2,
      );
      const fallback = pool.find(
        (item) =>
          !selectedIds.has(item.episode.id) &&
          (perSession.get(item.episode.sessionHash) ?? 0) < 2,
      );
      const chosen = candidate ?? fallback;
      if (!chosen) {
        throw new Error(
          `Only ${selected.filter((item) => item.engineerPseudonym === engineer).length} eligible independent conversational tasks for ${engineer}; need ${quota}`,
        );
      }
      selected.push(chosen);
      selectedIds.add(chosen.episode.id);
      perSession.set(
        chosen.episode.sessionHash,
        (perSession.get(chosen.episode.sessionHash) ?? 0) + 1,
      );
      cursor += 1;
    }
  }
  return selected.sort(
    (left, right) =>
      left.episode.timestamp.localeCompare(right.episode.timestamp) ||
      left.episode.id.localeCompare(right.episode.id),
  );
};

export const buildConversationalCodingCohort = async (input: {
  labRoot: string;
  outputDirectory: string;
  target?: number;
  sources?: readonly ConversationalSource[];
}): Promise<void> => {
  const target = input.target ?? 50;
  if (target < 40 || target > 60) {
    throw new Error("Conversational cohort target must be between 40 and 60");
  }
  const sources = input.sources ?? DEFAULT_CONVERSATIONAL_SOURCES;
  const seenRepresentations = new Set<string>();
  const candidates: ConversationalCandidate[] = [];
  const sourceInventory: Array<{
    engineerPseudonym: string;
    file: string;
    rows: number;
    managedContextRows: number;
    eligibleCodingRows: number;
  }> = [];
  for (const source of sources) {
    const absolute = path.resolve(input.labRoot, source.file);
    const episodes = await readJsonl<TaskEpisodeV2>(absolute);
    let managedContextRows = 0;
    let eligibleCodingRows = 0;
    for (const episode of episodes) {
      if (!hasManagedContext(episode)) continue;
      managedContextRows += 1;
      const combined = [
        episode.currentRequest,
        episode.taskAnchor ?? "",
        episode.precedingAssistant ?? "",
        ...(episode.earlierUserContext ?? []),
        episode.relevantDiagnostic ?? "",
      ].join("\n");
      if (
        !codingSignal.test(combined) ||
        excludedConversationalTopic.test(combined) ||
        episode.provenance.turnStatus !== "complete"
      ) {
        continue;
      }
      const representationHash = contentHash({
        engineer: source.engineerPseudonym,
        repositoryId: episode.repositoryId,
        currentRequest: normalizeText(episode.currentRequest),
        taskAnchor: normalizeText(episode.taskAnchor ?? ""),
        precedingAssistant: normalizeText(episode.precedingAssistant ?? ""),
        earlierUserContext: (episode.earlierUserContext ?? []).map(normalizeText),
        relevantDiagnostic: normalizeText(episode.relevantDiagnostic ?? ""),
      });
      if (seenRepresentations.has(representationHash)) continue;
      seenRepresentations.add(representationHash);
      eligibleCodingRows += 1;
      candidates.push({
        engineerPseudonym: source.engineerPseudonym,
        sourceFile: source.file,
        episode,
        stratum: classifyConversation(episode),
        score: conversationScore(episode),
      });
    }
    sourceInventory.push({
      engineerPseudonym: source.engineerPseudonym,
      file: source.file,
      rows: episodes.length,
      managedContextRows,
      eligibleCodingRows,
    });
  }
  const selected = selectConversationalCandidates(candidates, target);
  const splitMap = assignChronologicalSplits(
    selected.map((candidate) => candidate.episode),
  );
  const episodes = selected.map((candidate) => ({
    ...candidate.episode,
    split: splitMap.get(candidate.episode) ?? "test",
  }));
  const provenance = selected.map((candidate) => ({
    schemaVersion: 1,
    taskEpisodeId: candidate.episode.id,
    engineerPseudonym: candidate.engineerPseudonym,
    sourceFile: candidate.sourceFile,
    sourceSessionHash: candidate.episode.sessionHash,
    sourceLineageHash: candidate.episode.lineageHash,
    stratum: candidate.stratum,
    selectionScore: candidate.score,
    representation: "task-aware-context",
    contextFieldsPresent: {
      taskAnchor: Boolean(candidate.episode.taskAnchor),
      precedingAssistant: Boolean(candidate.episode.precedingAssistant),
      earlierUserContext: Boolean(candidate.episode.earlierUserContext?.length),
      relevantDiagnostic: Boolean(candidate.episode.relevantDiagnostic),
    },
  }));
  const counts = {
    total: episodes.length,
    engineers: Object.fromEntries(
      (["alen", "benjamin"] as const).map((engineer) => [
        engineer,
        selected.filter(
          (candidate) => candidate.engineerPseudonym === engineer,
        ).length,
      ]),
    ),
    repositories: Object.fromEntries(
      [...new Set(episodes.map((episode) => episode.repositoryId))]
        .sort()
        .map((repositoryId) => [
          repositoryId,
          episodes.filter((episode) => episode.repositoryId === repositoryId)
            .length,
        ]),
    ),
    strata: Object.fromEntries(
      (
        [
          "debugging_followup",
          "short_referential",
          "implementation_followup",
          "incomplete_specification",
        ] as const
      ).map((stratum) => [
        stratum,
        selected.filter((candidate) => candidate.stratum === stratum).length,
      ]),
    ),
    split: Object.fromEntries(
      (["reference", "validation", "test"] as const).map((split) => [
        split,
        episodes.filter((episode) => episode.split === split).length,
      ]),
    ),
    context: {
      taskAnchor: episodes.filter((episode) => episode.taskAnchor).length,
      precedingAssistant: episodes.filter(
        (episode) => episode.precedingAssistant,
      ).length,
      earlierUserContext: episodes.filter(
        (episode) => episode.earlierUserContext?.length,
      ).length,
      relevantDiagnostic: episodes.filter(
        (episode) => episode.relevantDiagnostic,
      ).length,
    },
  };
  if (episodes.some((episode) => !hasManagedContext(episode))) {
    throw new Error("Latest-request-only episode reached Cohort B");
  }
  const output = path.resolve(input.outputDirectory);
  await writeJsonl(output, "episodes.jsonl", episodes);
  await writeJsonl(output, "provenance.jsonl", provenance);
  await writeJson(output, "manifest.json", {
    schemaVersion: 1,
    specificationVersion: CONVERSATIONAL_COHORT_VERSION,
    generatedAt: new Date().toISOString(),
    representation: "task-aware-context",
    counts,
    sourceInventory,
    independencePolicy: {
      exactTaskAwareRepresentationsDeduplicated: true,
      oneEpisodePerLineage: true,
      maximumEpisodesPerSession: 2,
      repeatedDerivedVariantsCountAsIndependent: false,
    },
    gates: {
      targetBetween40And60: episodes.length >= 40 && episodes.length <= 60,
      everyEpisodeHasManagedContext: episodes.every(hasManagedContext),
      multipleIndependentEngineers:
        new Set(
          selected.map((candidate) => candidate.engineerPseudonym),
        ).size,
      note:
        "Only two independent engineers are present in the received transfers. This satisfies multi-engineer coverage but not a broader several-engineer claim.",
    },
    hashes: {
      episodes: contentHash(episodes),
      provenance: contentHash(provenance),
      episodeFileSha256: sha256(
        `${episodes.map((episode) => JSON.stringify(episode)).join("\n")}\n`,
      ),
    },
  });
  await writeFile(
    path.join(output, "audit.md"),
    [
      "# Cohort B — real conversational coding prompts",
      "",
      `Frozen tasks: ${counts.total}`,
      `Engineers: alen=${counts.engineers.alen}, benjamin=${counts.engineers.benjamin}`,
      `Strata: ${Object.entries(counts.strata)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
      "",
      "Every episode contains task-aware conversation context. There is no latest-request-only representation.",
      "",
      "## Limitation",
      "",
      "The available transfers contain two independent engineers, not three or more. Add another engineer later as a separately versioned cohort expansion; do not silently replace this frozen set.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
};

export interface PublicRepositoryDefinition {
  repository: string;
  name: string;
  purpose: string;
  languages: string[];
  frameworks: string[];
  registeredAreas: readonly PublicPrAreaDefinition[];
  naturalUnknownGroups: readonly {
    id: string;
    labels: readonly string[];
  }[];
  queryLabels: readonly string[];
}

export const KUBERNETES_PUBLIC_DEFINITION: PublicRepositoryDefinition = {
  repository: "kubernetes/kubernetes",
  name: "Kubernetes",
  purpose:
    "A large Go codebase for container orchestration, control-plane APIs, node agents, networking, scheduling, storage, authentication, and command-line operations.",
  languages: ["Go", "Shell", "Python"],
  frameworks: ["Kubernetes API machinery", "Cobra", "gRPC", "etcd"],
  registeredAreas: [
    {
      areaId: "api-machinery",
      name: "API machinery and API server",
      githubLabels: ["sig/api-machinery"],
      description:
        "API server behavior, API types, serialization, admission, discovery, storage machinery, clients, and custom resources.",
      inclusions: ["API server and admission", "API types and conversion", "Clients, discovery, and custom resources"],
      exclusions: ["Workload controller behavior", "Node runtime behavior"],
      confusableAreaIds: ["auth", "apps", "cli"],
      pathAnchors: ["staging/src/k8s.io/apimachinery", "staging/src/k8s.io/apiserver", "pkg/apis"],
      componentAnchors: ["kube-apiserver", "API machinery", "admission"],
      symbolAnchors: ["runtime.Object", "Scheme", "RESTStorage"],
      boundaryExamples: ["Changing API serialization belongs here; changing a Deployment rollout belongs to apps."],
    },
    {
      areaId: "apps",
      name: "Workload APIs and controllers",
      githubLabels: ["sig/apps"],
      description:
        "Deployments, StatefulSets, DaemonSets, Jobs, ReplicaSets, workload lifecycle, and their controllers.",
      inclusions: ["Workload APIs", "Workload controllers", "Rollout and lifecycle behavior"],
      exclusions: ["Scheduling decisions", "Container runtime on nodes"],
      confusableAreaIds: ["scheduling", "node", "api-machinery"],
      pathAnchors: ["pkg/controller", "pkg/apis/apps", "pkg/apis/batch"],
      componentAnchors: ["deployment controller", "job controller", "statefulset controller"],
      symbolAnchors: ["Deployment", "StatefulSet", "Job"],
      boundaryExamples: ["Reconciling a Deployment belongs here; choosing its node belongs to scheduling."],
    },
    {
      areaId: "auth",
      name: "Authentication, authorization, and security policy",
      githubLabels: ["sig/auth"],
      description:
        "Authentication, authorization, service accounts, credentials, RBAC, certificates, and security policy enforcement.",
      inclusions: ["Authentication and credentials", "Authorization and RBAC", "Service accounts and certificates"],
      exclusions: ["Generic API storage", "Network policy dataplane behavior"],
      confusableAreaIds: ["api-machinery", "network"],
      pathAnchors: ["pkg/authentication", "pkg/authorization", "plugin/pkg/auth"],
      componentAnchors: ["RBAC", "service accounts", "authentication"],
      symbolAnchors: ["Authorizer", "Authenticator", "ServiceAccount"],
      boundaryExamples: ["Deciding who may call an API belongs here; serving that API generally belongs to API machinery."],
    },
    {
      areaId: "cli",
      name: "kubectl and command-line workflows",
      githubLabels: ["sig/cli"],
      description:
        "kubectl commands, flags, output, apply behavior, command-line UX, and client-side workflows.",
      inclusions: ["kubectl commands", "CLI output and UX", "Client-side apply workflows"],
      exclusions: ["Server-side API implementation", "Cluster node behavior"],
      confusableAreaIds: ["api-machinery", "apps"],
      pathAnchors: ["staging/src/k8s.io/kubectl", "cmd/kubectl"],
      componentAnchors: ["kubectl", "command-line client"],
      symbolAnchors: ["KubectlOptions", "PrintFlags"],
      boundaryExamples: ["Formatting kubectl output belongs here; changing the served object belongs to API machinery."],
    },
    {
      areaId: "network",
      name: "Cluster networking and services",
      githubLabels: ["sig/network"],
      description:
        "Services, endpoints, kube-proxy, DNS, ingress, network policy, IP addressing, and cluster network behavior.",
      inclusions: ["Services and endpoints", "kube-proxy and network policy", "DNS, ingress, and IP allocation"],
      exclusions: ["Persistent storage", "Node container lifecycle"],
      confusableAreaIds: ["node", "api-machinery", "auth"],
      pathAnchors: ["pkg/proxy", "pkg/controller/endpoint", "pkg/apis/networking"],
      componentAnchors: ["kube-proxy", "services", "network policy"],
      symbolAnchors: ["Service", "EndpointSlice", "NetworkPolicy"],
      boundaryExamples: ["Routing traffic to Pods belongs here; starting their containers belongs to node."],
    },
    {
      areaId: "node",
      name: "Node, kubelet, and container lifecycle",
      githubLabels: ["sig/node"],
      description:
        "Kubelet, pod and container lifecycle, runtimes, resource management, node status, eviction, and host integration.",
      inclusions: ["Kubelet behavior", "Container and pod lifecycle", "Node resources and eviction"],
      exclusions: ["Scheduler placement algorithms", "Workload controller reconciliation"],
      confusableAreaIds: ["scheduling", "apps", "network"],
      pathAnchors: ["pkg/kubelet", "cmd/kubelet", "pkg/apis/node"],
      componentAnchors: ["kubelet", "container runtime", "node lifecycle"],
      symbolAnchors: ["Kubelet", "PodStatus", "ContainerRuntime"],
      boundaryExamples: ["Running a Pod on a selected node belongs here; selecting that node belongs to scheduling."],
    },
    {
      areaId: "scheduling",
      name: "Scheduling and placement",
      githubLabels: ["sig/scheduling"],
      description:
        "Scheduler framework, placement, predicates, scoring, preemption, queues, topology, and scheduling policy.",
      inclusions: ["Scheduler framework", "Placement and scoring", "Preemption and queues"],
      exclusions: ["Kubelet execution after placement", "Workload controller reconciliation"],
      confusableAreaIds: ["node", "apps"],
      pathAnchors: ["pkg/scheduler", "cmd/kube-scheduler"],
      componentAnchors: ["kube-scheduler", "scheduler framework"],
      symbolAnchors: ["Scheduler", "Framework", "PreFilterPlugin"],
      boundaryExamples: ["Selecting a node belongs here; starting the container belongs to node."],
    },
    {
      areaId: "storage",
      name: "Persistent storage and volumes",
      githubLabels: ["sig/storage"],
      description:
        "Volumes, persistent volume claims, CSI, attach/mount, storage classes, snapshots, and storage lifecycle.",
      inclusions: ["Persistent volumes and claims", "CSI and volume lifecycle", "Attach, mount, and snapshots"],
      exclusions: ["General node lifecycle", "API storage machinery"],
      confusableAreaIds: ["node", "api-machinery"],
      pathAnchors: ["pkg/volume", "pkg/controller/volume", "staging/src/k8s.io/csi-translation-lib"],
      componentAnchors: ["CSI", "persistent volumes", "volume manager"],
      symbolAnchors: ["PersistentVolume", "VolumePlugin", "CSIDriver"],
      boundaryExamples: ["Mounting a persistent volume belongs here; generic kubelet process management belongs to node."],
    },
  ],
  naturalUnknownGroups: [
    { id: "instrumentation", labels: ["sig/instrumentation"] },
    { id: "testing", labels: ["sig/testing"] },
    { id: "cluster-lifecycle", labels: ["sig/cluster-lifecycle"] },
    { id: "release", labels: ["sig/release"] },
  ],
  queryLabels: [
    "sig/api-machinery",
    "sig/apps",
    "sig/auth",
    "sig/cli",
    "sig/network",
    "sig/node",
    "sig/scheduling",
    "sig/storage",
    "sig/instrumentation",
    "sig/testing",
    "sig/cluster-lifecycle",
    "sig/release",
  ],
};

const grafanaArea = (
  areaId: string,
  name: string,
  githubLabels: string[],
  description: string,
  confusableAreaIds: string[],
  pathAnchors: string[],
  componentAnchors: string[],
): PublicPrAreaDefinition => ({
  areaId,
  name,
  githubLabels,
  description,
  inclusions: componentAnchors,
  exclusions: [],
  confusableAreaIds,
  pathAnchors,
  componentAnchors,
  symbolAnchors: [],
  boundaryExamples: [],
});

export const GRAFANA_PUBLIC_DEFINITION: PublicRepositoryDefinition = {
  repository: "grafana/grafana",
  name: "Grafana",
  purpose:
    "A mixed Go and TypeScript observability application spanning dashboards, visualizations, data sources, alerting, plugins, authentication, and backend/frontend platform boundaries.",
  languages: ["Go", "TypeScript", "JavaScript", "SCSS"],
  frameworks: ["React", "Redux", "Go services", "Grafana plugin platform"],
  registeredAreas: [
    grafanaArea("dashboards", "Dashboards and templating", ["area/dashboard", "area/dashboard/templating"], "Dashboard models, editing, folders, variables, links, history, import, and dashboard UX.", ["frontend-navigation", "visualization-ui"], ["public/app/features/dashboard", "pkg/services/dashboards"], ["dashboard editor", "templating", "folders"]),
    grafanaArea("alerting", "Alerting and notifications", ["area/alerting", "area/alerting/evaluation", "area/alerting/notifications"], "Alert rules, evaluation, state, contact points, notifications, and alerting UI/backend behavior.", ["backend-platform", "data-sources"], ["pkg/services/ngalert", "public/app/features/alerting"], ["alert evaluation", "contact points", "alert rules"]),
    grafanaArea("auth-security", "Authentication and security", ["area/auth", "area/security", "area/backend/security", "area/frontend/login"], "Login, OAuth, LDAP, sessions, authorization, user identity, and security controls.", ["backend-platform", "frontend-navigation"], ["pkg/services/auth", "pkg/login", "public/app/features/auth"], ["login", "OAuth", "LDAP", "security"]),
    grafanaArea("data-sources", "Data sources, queries, and Explore", ["area/datasource", "area/datasource/frontend", "area/datasource/backend", "area/query-editor", "area/explore"], "Data-source configuration and plugins, query editors, proxying, query execution, and Explore.", ["plugins", "backend-platform", "visualization-ui"], ["public/app/features/datasources", "public/app/features/explore", "pkg/services/proxy"], ["data sources", "query editor", "Explore"]),
    grafanaArea("plugins", "Plugins and extensions", ["area/plugins", "area/plugins/app", "area/backend/plugins", "area/plugins-catalog"], "Plugin loading, app plugins, extension points, catalog, signatures, and plugin lifecycle.", ["data-sources", "backend-platform", "frontend-navigation"], ["pkg/plugins", "public/app/features/plugins"], ["plugin loader", "app plugins", "extensions"]),
    grafanaArea("visualization-ui", "Panels, visualizations, and UI primitives", ["area/panel/common", "area/grafana/ui", "area/transformations", "area/dataframe", "area/value-mapping"], "Panel rendering, visualization options, transformations, data frames, field configuration, and shared UI components.", ["dashboards", "data-sources", "frontend-navigation"], ["public/app/plugins/panel", "packages/grafana-ui", "packages/grafana-data"], ["panels", "visualizations", "transformations"]),
    grafanaArea("backend-platform", "Backend services, APIs, configuration, and persistence", ["area/backend", "area/backend/api", "area/backend/db", "area/http-server", "area/configuration", "area/provisioning"], "Go backend services, HTTP APIs, database behavior, configuration, provisioning, and server infrastructure.", ["auth-security", "plugins", "alerting"], ["pkg/api", "pkg/services", "pkg/setting"], ["HTTP server", "database", "provisioning"]),
    grafanaArea("frontend-navigation", "Frontend shell, navigation, search, and routing", ["area/frontend", "area/navigation", "area/search", "area/routing", "area/internationalization"], "Frontend application shell, navigation, routing, search, page composition, and cross-feature UI behavior.", ["dashboards", "visualization-ui", "auth-security"], ["public/app/core", "public/app/features/search"], ["navigation", "routing", "frontend shell"]),
  ],
  naturalUnknownGroups: [
    { id: "build-packaging", labels: ["type/build-packaging"] },
    { id: "documentation", labels: ["type/docs"] },
    { id: "ci", labels: ["type/ci"] },
    { id: "instrumentation", labels: ["area/instrumentation"] },
  ],
  queryLabels: [
    "area/dashboard",
    "area/alerting",
    "area/auth",
    "area/datasource",
    "area/plugins",
    "area/panel/common",
    "area/grafana/ui",
    "area/backend",
    "area/frontend",
    "type/build-packaging",
    "type/docs",
    "type/ci",
    "area/instrumentation",
  ],
};

interface GhPull {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
  labels: Array<{ name: string }>;
  author: { login: string } | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  url: string;
}

interface PublicCandidate {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeCommitOid: string;
  labels: string[];
  authorLogin: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  url: string;
  mappedAreaIds: string[];
  unknownGroupIds: string[];
  samplingKind: "known" | "multi_area" | "natural_unknown";
  samplingAreaId: string;
}

interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  resolutionMethod:
    | "closing_reference"
    | "connected_event"
    | "explicit_body_reference"
    | "cross_reference";
  candidateCount: number;
}

interface MaterializedPublicCandidate extends PublicCandidate {
  preTaskSnapshot: string;
  actualChangedPaths: string[];
  linkedIssue: LinkedIssue;
  taskText: string;
  split: Split;
}

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const ghJson = async <T>(args: readonly string[]): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await execFileAsync("gh", [...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === 3 ||
        !/(?:HTTP 5\d\d|timeout|connection reset|stream error|received from peer)/iu.test(
          message,
        )
      ) {
        throw error;
      }
      await sleep(1_000 * 2 ** attempt);
    }
  }
  throw lastError;
};

const labelMatches = (label: string, configured: string): boolean =>
  label === configured ||
  (configured.endsWith("/*") &&
    label.startsWith(configured.slice(0, -1)));

const categorizeCandidate = (
  definition: PublicRepositoryDefinition,
  pull: GhPull,
): PublicCandidate | undefined => {
  const labels = pull.labels.map((label) => label.name).sort();
  let mappedAreaIds = definition.registeredAreas
    .filter((area) =>
      area.githubLabels.some((configured) =>
        labels.some((label) => labelMatches(label, configured)),
      ),
    )
    .map((area) => area.areaId);
  if (definition.repository === "grafana/grafana" && mappedAreaIds.length > 1) {
    if (
      mappedAreaIds.includes("frontend-navigation") &&
      labels.includes("area/frontend") &&
      !labels.some((label) =>
        [
          "area/navigation",
          "area/search",
          "area/routing",
          "area/internationalization",
        ].includes(label),
      )
    ) {
      mappedAreaIds = mappedAreaIds.filter(
        (areaId) => areaId !== "frontend-navigation",
      );
    }
    if (
      mappedAreaIds.includes("backend-platform") &&
      labels.includes("area/backend") &&
      !labels.some((label) =>
        [
          "area/backend/api",
          "area/backend/db",
          "area/http-server",
          "area/configuration",
          "area/provisioning",
        ].includes(label),
      )
    ) {
      mappedAreaIds = mappedAreaIds.filter(
        (areaId) => areaId !== "backend-platform",
      );
    }
  }
  const unknownGroupIds = definition.naturalUnknownGroups
    .filter((group) =>
      group.labels.some((configured) =>
        labels.some((label) => labelMatches(label, configured)),
      ),
    )
    .map((group) => group.id);
  const samplingKind =
    mappedAreaIds.length > 1
      ? "multi_area"
      : mappedAreaIds.length === 1
        ? "known"
        : unknownGroupIds.length > 0
          ? "natural_unknown"
          : undefined;
  if (!samplingKind) return undefined;
  const login = pull.author?.login.toLowerCase() ?? "";
  if (
    login.includes("bot") ||
    login.includes("dependabot") ||
    pull.changedFiles < 1 ||
    pull.changedFiles > 40 ||
    !pull.mergeCommit?.oid ||
    !pull.mergedAt ||
    /\b(?:backport|cherry[- ]pick|dependency update|version packages)\b/iu.test(
      pull.title,
    )
  ) {
    return undefined;
  }
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    mergedAt: pull.mergedAt,
    mergeCommitOid: pull.mergeCommit.oid,
    labels,
    authorLogin: pull.author?.login ?? "unknown",
    changedFiles: pull.changedFiles,
    additions: pull.additions,
    deletions: pull.deletions,
    url: pull.url,
    mappedAreaIds,
    unknownGroupIds,
    samplingKind,
    samplingAreaId:
      samplingKind === "known"
        ? mappedAreaIds[0]!
        : samplingKind === "multi_area"
          ? mappedAreaIds.sort().join("+")
          : unknownGroupIds[0]!,
  };
};

const publicCandidateScore = (candidate: PublicCandidate): number => {
  let score = 0;
  const bodyLength = candidate.body.trim().length;
  if (bodyLength >= 100 && bodyLength <= 8_000) score += 5;
  if (candidate.changedFiles <= 12) score += 3;
  if (candidate.changedFiles <= 5) score += 2;
  if (/^(?:fix|feat|refactor|perf|test)(?:\([^)]+\))?!?:/iu.test(candidate.title)) {
    score += 2;
  }
  return score;
};

const collectPublicCandidatePool = async (
  definition: PublicRepositoryDefinition,
  limitPerLabel: number,
): Promise<PublicCandidate[]> => {
  const byNumber = new Map<number, PublicCandidate>();
  for (const label of definition.queryLabels) {
    const pulls = await ghJson<GhPull[]>([
      "pr",
      "list",
      "-R",
      definition.repository,
      "--state",
      "merged",
      "--search",
      `label:"${label}" linked:issue merged:>=2024-01-01`,
      "--limit",
      String(limitPerLabel),
      "--json",
      "number,title,body,mergedAt,mergeCommit,labels,author,changedFiles,additions,deletions,url",
    ]);
    for (const pull of pulls) {
      const candidate = categorizeCandidate(definition, pull);
      if (candidate) byNumber.set(candidate.number, candidate);
    }
  }
  return [...byNumber.values()];
};

interface GraphQlIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  __typename?: string;
}

interface ClosingIssueResponse {
  data: {
    repository: {
      pullRequest: {
        closingIssuesReferences: { nodes: GraphQlIssue[] };
        timelineItems: {
          nodes: Array<
            | {
                __typename: "ConnectedEvent";
                subject: GraphQlIssue;
              }
            | {
                __typename: "CrossReferencedEvent";
                source: GraphQlIssue;
              }
          >;
        };
      } | null;
    } | null;
  };
}

const extractRepositoryIssueNumbers = (
  body: string,
  repository: string,
): number[] => {
  const [owner, name] = repository.split("/");
  const numbers = new Set<number>();
  const escapedRepository = `${owner}/${name}`.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  for (const match of body.matchAll(
    new RegExp(
      `https?://github\\.com/${escapedRepository}/issues/(\\d+)`,
      "giu",
    ),
  )) {
    numbers.add(Number(match[1]));
  }
  for (const match of body.matchAll(
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|address(?:e[sd])?|issue|ref(?:erence)?s?)\s*:?\s*#(\d+)/giu,
  )) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].filter(Number.isSafeInteger).sort((a, b) => a - b);
};

const linkedIssueForCandidate = async (
  definition: PublicRepositoryDefinition,
  candidate: PublicCandidate,
): Promise<LinkedIssue | undefined> => {
  const [owner, name] = definition.repository.split("/");
  if (!owner || !name) throw new Error("Invalid repository");
  const response = await ghJson<ClosingIssueResponse>([
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
  const pull = response.data.repository?.pullRequest;
  if (!pull) return undefined;
  const ranked = new Map<
    number,
    { issue: GraphQlIssue; rank: number; method: LinkedIssue["resolutionMethod"] }
  >();
  const offer = (
    issue: GraphQlIssue | undefined,
    rank: number,
    method: LinkedIssue["resolutionMethod"],
  ): void => {
    if (!issue || issue.__typename === "PullRequest") return;
    const existing = ranked.get(issue.number);
    if (!existing || rank < existing.rank) {
      ranked.set(issue.number, { issue, rank, method });
    }
  };
  for (const issue of pull.closingIssuesReferences.nodes) {
    offer(issue, 0, "closing_reference");
  }
  for (const event of pull.timelineItems.nodes) {
    if (event.__typename === "ConnectedEvent") {
      offer(event.subject, 1, "connected_event");
    } else if (event.source.__typename === "Issue") {
      offer(event.source, 3, "cross_reference");
    }
  }
  for (const issueNumber of extractRepositoryIssueNumbers(
    candidate.body,
    definition.repository,
  )) {
    if (ranked.has(issueNumber)) continue;
    try {
      const issue = await ghJson<
        GraphQlIssue & { html_url: string; pull_request?: unknown }
      >([
        "api",
        `repos/${definition.repository}/issues/${issueNumber}`,
      ]);
      if (!issue.pull_request) {
        offer(
          { ...issue, url: issue.html_url },
          2,
          "explicit_body_reference",
        );
      }
    } catch {
      // A stale or cross-repository reference is not a usable task source.
    }
  }
  const candidates = [...ranked.values()].sort(
    (left, right) =>
      left.rank - right.rank ||
      right.issue.body.trim().length - left.issue.body.trim().length ||
      left.issue.number - right.issue.number,
  );
  const selected = candidates[0];
  if (!selected) return undefined;
  return {
    number: selected.issue.number,
    title: selected.issue.title,
    body: selected.issue.body ?? "",
    url: selected.issue.url,
    resolutionMethod: selected.method,
    candidateCount: candidates.filter(
      (item) => item.rank === selected.rank,
    ).length,
  };
};

const materializePublicCandidate = async (
  definition: PublicRepositoryDefinition,
  candidate: PublicCandidate,
): Promise<MaterializedPublicCandidate | undefined> => {
  const issue = await linkedIssueForCandidate(definition, candidate);
  if (!issue) return undefined;
  const taskText = buildPublicIssueTaskText(issue.title, issue.body);
  if (
    taskText.trim().length < 50 ||
    extractPublicIssueProblemStatement(issue.body).trim().length < 20
  ) {
    return undefined;
  }
  const commit = await ghJson<{ parents: Array<{ sha: string }> }>([
    "api",
    `repos/${definition.repository}/git/commits/${candidate.mergeCommitOid}`,
  ]);
  const preTaskSnapshot = commit.parents[0]?.sha;
  if (!preTaskSnapshot) return undefined;
  const files = await ghJson<Array<{ filename: string }>>([
    "api",
    "--paginate",
    `repos/${definition.repository}/pulls/${candidate.number}/files?per_page=100`,
  ]);
  return {
    ...candidate,
    preTaskSnapshot,
    actualChangedPaths: files.map((file) => file.filename).sort(),
    linkedIssue: issue,
    taskText,
    split: "reference",
  };
};

const candidateOrder = (
  candidates: readonly PublicCandidate[],
): PublicCandidate[] =>
  [...candidates].sort(
    (left, right) =>
      publicCandidateScore(right) - publicCandidateScore(left) ||
      right.mergedAt.localeCompare(left.mergedAt) ||
      right.number - left.number,
  );

const collectRepositoryPublicTasks = async (
  definition: PublicRepositoryDefinition,
  input: {
    knownPerArea: number;
    multiArea: number;
    naturalUnknown: number;
    limitPerLabel: number;
  },
): Promise<MaterializedPublicCandidate[]> => {
  const pool = await collectPublicCandidatePool(
    definition,
    input.limitPerLabel,
  );
  const selected: MaterializedPublicCandidate[] = [];
  const issueNumbers = new Set<number>();
  const pullNumbers = new Set<number>();
  const take = async (
    candidates: readonly PublicCandidate[],
    quota: number,
    description: string,
  ): Promise<void> => {
    let count = 0;
    for (const candidate of candidateOrder(candidates)) {
      if (count >= quota) break;
      if (pullNumbers.has(candidate.number)) continue;
      const materialized = await materializePublicCandidate(
        definition,
        candidate,
      );
      if (
        !materialized ||
        issueNumbers.has(materialized.linkedIssue.number)
      ) {
        continue;
      }
      selected.push(materialized);
      pullNumbers.add(materialized.number);
      issueNumbers.add(materialized.linkedIssue.number);
      count += 1;
    }
    if (count < quota) {
      throw new Error(
        `${definition.repository}: collected ${count}/${quota} ${description} tasks`,
      );
    }
  };
  for (const area of definition.registeredAreas) {
    await take(
      pool.filter(
        (candidate) =>
          candidate.samplingKind === "known" &&
          candidate.samplingAreaId === area.areaId,
      ),
      input.knownPerArea,
      `known ${area.areaId}`,
    );
  }
  await take(
    pool.filter((candidate) => candidate.samplingKind === "multi_area"),
    input.multiArea,
    "multi-area",
  );
  await take(
    pool.filter((candidate) => candidate.samplingKind === "natural_unknown"),
    input.naturalUnknown,
    "natural-open-set",
  );
  const chronological = [...selected].sort(
    (left, right) =>
      left.mergedAt.localeCompare(right.mergedAt) ||
      left.number - right.number,
  );
  const splits = new Map<number, Split>();
  for (const [index, candidate] of chronological.entries()) {
    const fraction = index / Math.max(1, chronological.length);
    splits.set(
      candidate.number,
      fraction < 0.5
        ? "reference"
        : fraction < 0.75
          ? "validation"
          : "test",
    );
  }
  return selected
    .map((candidate) => ({
      ...candidate,
      split: splits.get(candidate.number) ?? "test",
    }))
    .sort(
      (left, right) =>
        left.mergedAt.localeCompare(right.mergedAt) ||
        left.number - right.number,
    );
};

const publicAreaCards = (
  definition: PublicRepositoryDefinition,
): AreaCardV1[] =>
  definition.registeredAreas.map((area) => ({
    schemaVersion: 1,
    registryVersion: `${definition.repository.replace("/", "-")}-public-areas-v1`,
    repositoryId: definition.repository,
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
        repository: definition.repository,
        areaId: area.areaId,
        labels: area.githubLabels,
      }),
    ],
    generatorVersion: DIVERSE_PUBLIC_COHORT_VERSION,
  }));

const directAreaCues = (
  taskText: string,
  definition: PublicRepositoryDefinition,
): string[] =>
  definition.registeredAreas
    .filter((area) => {
      const terms = [
        area.areaId,
        area.name,
        ...area.githubLabels,
        ...area.componentAnchors,
      ];
      return terms.some((term) => {
        if (term.length < 4) return false;
        const normalized = term
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "[\\s_./:@-]*");
        return new RegExp(
          `(?:^|[^\\p{L}\\p{N}])${normalized}(?:$|[^\\p{L}\\p{N}])`,
          "iu",
        ).test(taskText);
      });
    })
    .map((area) => area.areaId);

const directRegisteredAreaNameCues = (
  taskText: string,
  definition: PublicRepositoryDefinition,
): string[] => {
  const normalizedTask = taskText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return definition.registeredAreas
    .filter((area) =>
      [area.areaId, area.name, ...area.githubLabels].some((term) => {
        const normalizedTerm = term
          .replace(/^(?:sig|area)[/:]/iu, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim();
        return (
          normalizedTerm.length >= 4 &&
          new RegExp(
            `(?:^| )${normalizedTerm.replaceAll(" ", " +")}(?: |$)`,
            "iu",
          ).test(normalizedTask)
        );
      }),
    )
    .map((area) => area.areaId);
};

const hasExactRepositoryLocator = (taskText: string): boolean =>
  /(?:^|[\s`(])(?:pkg|cmd|staging|test|tests|vendor|public|packages|apps|conf|devenv|scripts?)\/[\w./*-]+/imu.test(
    taskText,
  ) ||
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\//iu.test(taskText);

const outputPublicRepository = async (
  definition: PublicRepositoryDefinition,
  materialized: readonly MaterializedPublicCandidate[],
  outputDirectory: string,
): Promise<void> => {
  const episodes: TaskEpisodeV1[] = materialized.map((candidate) => ({
    schemaVersion: 1,
    id: `${definition.repository.replace("/", "-")}-pr-${candidate.number}`,
    repositoryId: definition.repository,
    repositorySnapshot: candidate.preTaskSnapshot,
    sessionHash: contentHash(
      `github:${definition.repository}:issue:${candidate.linkedIssue.number}`,
    ),
    lineageHash: contentHash(
      `github:${definition.repository}:issue:${candidate.linkedIssue.number}`,
    ),
    timestamp: new Date(candidate.mergedAt).toISOString(),
    split: candidate.split,
    currentRequest: candidate.taskText,
    source: "github",
  }));
  const cards = publicAreaCards(definition);
  const evidence = materialized.map((candidate, index) => ({
    schemaVersion: 1,
    taskEpisodeId: episodes[index]!.id,
    pullRequestNumber: candidate.number,
    pullRequestUrl: candidate.url,
    linkedIssue: {
      number: candidate.linkedIssue.number,
      url: candidate.linkedIssue.url,
      resolutionMethod: candidate.linkedIssue.resolutionMethod,
      candidateCount: candidate.linkedIssue.candidateCount,
    },
    mergeCommit: candidate.mergeCommitOid,
    preTaskSnapshot: candidate.preTaskSnapshot,
    githubLabels: candidate.labels,
    mappedAreaIds: candidate.mappedAreaIds,
    unknownGroupIds: candidate.unknownGroupIds,
    samplingKind: candidate.samplingKind,
    samplingAreaId: candidate.samplingAreaId,
    actualChangedPaths: candidate.actualChangedPaths,
    policy:
      "Offline construction and audit evidence only. Never expose labels, changed paths, merge commits, or post-task diffs to Sol or Luna.",
  }));
  const profile: RepositoryProfileV1 = {
    schemaVersion: 1,
    repositoryId: definition.repository,
    snapshot: materialized.at(-1)!.preTaskSnapshot,
    name: definition.name,
    purpose: definition.purpose,
    languages: [...definition.languages],
    frameworks: [...definition.frameworks],
    components: definition.registeredAreas.map((area) => ({
      name: area.name,
      purpose: area.description,
      paths: [...area.pathAnchors],
    })),
    generatorVersion: DIVERSE_PUBLIC_COHORT_VERSION,
  };
  const audits = materialized.map((candidate, index) => {
    const cues = directAreaCues(candidate.taskText, definition);
    const locator = hasExactRepositoryLocator(candidate.taskText);
    return {
      schemaVersion: 1,
      taskEpisodeId: episodes[index]!.id,
      taskCharacters: candidate.taskText.length,
      directRegisteredAreaCues: cues,
      hasExactRepositoryLocator: locator,
      toolOpportunity:
        cues.length === 0 && !locator
          ? "high"
          : cues.length === 0
            ? "medium"
            : "low",
      possibleImplementationLeakage:
        /(?:^|\n)(?:#{1,6}\s*)?(?:proposal|proposed solution|solution|root cause|implementation|the fix)\s*:?\s*(?:\n|$)/iu.test(
          candidate.taskText,
        ),
    };
  });
  await writeJson(outputDirectory, "repository-profile.json", profile);
  await writeJsonl(outputDirectory, "area-cards.jsonl", cards);
  await writeJsonl(outputDirectory, "episodes.jsonl", episodes);
  await writeJsonl(outputDirectory, "offline-evidence.jsonl", evidence);
  await writeJson(outputDirectory, "task-audit.json", {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      total: audits.length,
      highToolOpportunity: audits.filter(
        (audit) => audit.toolOpportunity === "high",
      ).length,
      mediumToolOpportunity: audits.filter(
        (audit) => audit.toolOpportunity === "medium",
      ).length,
      lowToolOpportunity: audits.filter(
        (audit) => audit.toolOpportunity === "low",
      ).length,
      possibleImplementationLeakage: audits.filter(
        (audit) => audit.possibleImplementationLeakage,
      ).length,
    },
    audits,
  });
  await writeJson(outputDirectory, "manifest.json", {
    schemaVersion: 1,
    specificationVersion: DIVERSE_PUBLIC_COHORT_VERSION,
    generatedAt: new Date().toISOString(),
    repository: definition.repository,
    counts: {
      total: episodes.length,
      known: materialized.filter(
        (candidate) => candidate.samplingKind === "known",
      ).length,
      multiArea: materialized.filter(
        (candidate) => candidate.samplingKind === "multi_area",
      ).length,
      naturalUnknown: materialized.filter(
        (candidate) => candidate.samplingKind === "natural_unknown",
      ).length,
      bySplit: Object.fromEntries(
        (["reference", "validation", "test"] as const).map((split) => [
          split,
          episodes.filter((episode) => episode.split === split).length,
        ]),
      ),
      byKnownArea: Object.fromEntries(
        definition.registeredAreas.map((area) => [
          area.areaId,
          materialized.filter(
            (candidate) =>
              candidate.samplingKind === "known" &&
              candidate.samplingAreaId === area.areaId,
          ).length,
        ]),
      ),
    },
    taskSource: "linked GitHub issue only",
    snapshotPolicy: "first parent of the PR merge commit",
    leakagePolicy: {
      runtimeEpisodesContainGithubLabels: false,
      runtimeEpisodesContainChangedPaths: false,
      runtimeEpisodesContainMergeCommit: false,
      offlineEvidenceMayBeJoinedOnlyAfterPredictionsFreeze: true,
    },
    hashes: {
      profile: contentHash(profile),
      cards: contentHash(cards),
      episodes: contentHash(episodes),
      evidence: contentHash(evidence),
      episodeFileSha256: sha256(
        `${episodes.map((episode) => JSON.stringify(episode)).join("\n")}\n`,
      ),
    },
  });
};

export const buildDiversePublicCohort = async (input: {
  outputDirectory: string;
  knownPerArea?: number;
  multiAreaPerRepository?: number;
  naturalUnknownPerRepository?: number;
  limitPerLabel?: number;
}): Promise<void> => {
  const knownPerArea = input.knownPerArea ?? 2;
  const multiArea = input.multiAreaPerRepository ?? 6;
  const naturalUnknown = input.naturalUnknownPerRepository ?? 6;
  const limitPerLabel = input.limitPerLabel ?? 70;
  const definitions = [
    KUBERNETES_PUBLIC_DEFINITION,
    GRAFANA_PUBLIC_DEFINITION,
  ] as const;
  const combinedEpisodes: TaskEpisodeV1[] = [];
  const combinedEvidence: unknown[] = [];
  const combinedCards: AreaCardV1[] = [];
  for (const definition of definitions) {
    const materialized = await collectRepositoryPublicTasks(definition, {
      knownPerArea,
      multiArea,
      naturalUnknown,
      limitPerLabel,
    });
    const repositoryDirectory = path.join(
      path.resolve(input.outputDirectory),
      definition.repository.split("/")[1]!,
    );
    await outputPublicRepository(
      definition,
      materialized,
      repositoryDirectory,
    );
    combinedEpisodes.push(
      ...(await readJsonl<TaskEpisodeV1>(
        path.join(repositoryDirectory, "episodes.jsonl"),
      )),
    );
    combinedEvidence.push(
      ...(await readJsonl<unknown>(
        path.join(repositoryDirectory, "offline-evidence.jsonl"),
      )),
    );
    combinedCards.push(
      ...(await readJsonl<AreaCardV1>(
        path.join(repositoryDirectory, "area-cards.jsonl"),
      )),
    );
  }
  const output = path.resolve(input.outputDirectory);
  if (combinedEpisodes.length < 40 || combinedEpisodes.length > 60) {
    throw new Error(
      `Cohort C must contain 40–60 tasks; got ${combinedEpisodes.length}`,
    );
  }
  await writeJsonl(output, "episodes.jsonl", combinedEpisodes);
  await writeJsonl(output, "offline-evidence.jsonl", combinedEvidence);
  await writeJsonl(output, "area-cards.jsonl", combinedCards);
  await writeJson(output, "manifest.json", {
    schemaVersion: 1,
    specificationVersion: DIVERSE_PUBLIC_COHORT_VERSION,
    generatedAt: new Date().toISOString(),
    repositories: definitions.map((definition) => definition.repository),
    counts: {
      total: combinedEpisodes.length,
      byRepository: Object.fromEntries(
        definitions.map((definition) => [
          definition.repository,
          combinedEpisodes.filter(
            (episode) => episode.repositoryId === definition.repository,
          ).length,
        ]),
      ),
    },
    policy:
      "Issue text is runtime input. Labels, changed paths, merge commits, and issue/PR relation metadata remain offline.",
    hashes: {
      episodes: contentHash(combinedEpisodes),
      evidence: contentHash(combinedEvidence),
      cards: contentHash(combinedCards),
    },
  });
};

interface PublicOfflineEvidence {
  taskEpisodeId: string;
  pullRequestNumber: number;
  linkedIssue: { number: number; url: string };
  preTaskSnapshot: string;
  mappedAreaIds: string[];
  unknownGroupIds: string[];
  samplingKind: "known" | "multi_area" | "natural_unknown";
  samplingAreaId: string;
  actualChangedPaths: string[];
}

const plausibleAreasForHardCase = (
  evidence: PublicOfflineEvidence,
  cards: readonly AreaCardV1[],
): string[] => {
  const repositoryCards = cards.filter((card) =>
    evidence.taskEpisodeId.startsWith(card.repositoryId.replace("/", "-")),
  );
  const plausible = new Set(evidence.mappedAreaIds);
  for (const mapped of evidence.mappedAreaIds) {
    const card = repositoryCards.find((item) => item.areaId === mapped);
    for (const confusable of card?.confusableAreaIds ?? []) {
      plausible.add(confusable);
      if (plausible.size >= 3) break;
    }
  }
  if (plausible.size < 2) {
    const pathScores = repositoryCards
      .map((card) => ({
        areaId: card.areaId,
        score: evidence.actualChangedPaths.filter((changedPath) =>
          card.pathAnchors.some((anchor) =>
            changedPath.startsWith(anchor.replace(/\*.*$/u, "")),
          ),
        ).length,
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.areaId.localeCompare(right.areaId),
      );
    for (const item of pathScores) {
      if (item.score > 0 || plausible.size === 0) plausible.add(item.areaId);
      if (plausible.size >= 2) break;
    }
  }
  for (const card of repositoryCards) {
    if (plausible.size >= 2) break;
    plausible.add(card.areaId);
  }
  return [...plausible].slice(0, 3);
};

export const buildNaturalHardCohort = async (input: {
  publicCohortDirectory: string;
  outputDirectory: string;
  target?: number;
}): Promise<void> => {
  const target = input.target ?? 24;
  if (target < 24) throw new Error("Natural hard cohort needs at least 24 tasks");
  const episodes = await readJsonl<TaskEpisodeV1>(
    path.join(input.publicCohortDirectory, "episodes.jsonl"),
  );
  const evidence = await readJsonl<PublicOfflineEvidence>(
    path.join(input.publicCohortDirectory, "offline-evidence.jsonl"),
  );
  const cards = await readJsonl<AreaCardV1>(
    path.join(input.publicCohortDirectory, "area-cards.jsonl"),
  );
  const evidenceById = new Map(
    evidence.map((item) => [item.taskEpisodeId, item]),
  );
  const definitions = new Map([
    ["kubernetes/kubernetes", KUBERNETES_PUBLIC_DEFINITION],
    ["grafana/grafana", GRAFANA_PUBLIC_DEFINITION],
  ]);
  const eligible = episodes
    .map((episode) => {
      if (episode.split === "test") return undefined;
      const item = evidenceById.get(episode.id);
      const definition = definitions.get(episode.repositoryId);
      if (!item || !definition) return undefined;
      const cues = directRegisteredAreaNameCues(
        episode.currentRequest,
        definition,
      );
      const locator = hasExactRepositoryLocator(episode.currentRequest);
      const plausibleAreaIds = plausibleAreasForHardCase(item, cards);
      if (cues.length > 0 || locator || plausibleAreaIds.length < 2) {
        return undefined;
      }
      return { episode, evidence: item, plausibleAreaIds };
    })
    .filter((value) => value !== undefined);
  const strata = [
    "known",
    "multi_area",
    "natural_unknown",
  ] as const;
  const baselinePerStratum = Math.max(6, Math.floor(target / 4));
  const quotas = new Map<
    (typeof strata)[number],
    number
  >([
    ["known", baselinePerStratum],
    ["multi_area", Math.floor((target - baselinePerStratum) / 2)],
    [
      "natural_unknown",
      target -
        baselinePerStratum -
        Math.floor((target - baselinePerStratum) / 2),
    ],
  ]);
  const existingPulls = new Set(
    evidence.map(
      (item) =>
        `${item.taskEpisodeId.startsWith("kubernetes-") ? "kubernetes/kubernetes" : "grafana/grafana"}:${item.pullRequestNumber}`,
    ),
  );
  const existingIssues = new Set(
    evidence.map(
      (item) =>
        `${item.taskEpisodeId.startsWith("kubernetes-") ? "kubernetes/kubernetes" : "grafana/grafana"}:${item.linkedIssue.number}`,
    ),
  );
  for (const stratum of strata) {
    const quota = quotas.get(stratum)!;
    let current = eligible.filter(
      (item) => item.evidence.samplingKind === stratum,
    ).length;
    if (current >= quota) continue;
    for (const definition of [
      KUBERNETES_PUBLIC_DEFINITION,
      GRAFANA_PUBLIC_DEFINITION,
    ]) {
      const pool = candidateOrder(
        (await collectPublicCandidatePool(definition, 100)).filter(
          (candidate) =>
            candidate.samplingKind === stratum &&
            !existingPulls.has(
              `${definition.repository}:${candidate.number}`,
            ) &&
            directRegisteredAreaNameCues(
              candidate.title,
              definition,
            ).length === 0 &&
            !hasExactRepositoryLocator(candidate.title),
        ),
      );
      for (const candidate of pool) {
        if (current >= quota) break;
        const materialized = await materializePublicCandidate(
          definition,
          candidate,
        );
        if (!materialized) continue;
        const issueKey = `${definition.repository}:${materialized.linkedIssue.number}`;
        if (existingIssues.has(issueKey)) continue;
        if (
          directRegisteredAreaNameCues(
            materialized.taskText,
            definition,
          ).length > 0 ||
          hasExactRepositoryLocator(materialized.taskText)
        ) {
          continue;
        }
        const taskEpisodeId = `${definition.repository.replace("/", "-")}-pr-${materialized.number}`;
        const supplementalEvidence: PublicOfflineEvidence = {
          taskEpisodeId,
          pullRequestNumber: materialized.number,
          linkedIssue: {
            number: materialized.linkedIssue.number,
            url: materialized.linkedIssue.url,
          },
          preTaskSnapshot: materialized.preTaskSnapshot,
          mappedAreaIds: materialized.mappedAreaIds,
          unknownGroupIds: materialized.unknownGroupIds,
          samplingKind: materialized.samplingKind,
          samplingAreaId: materialized.samplingAreaId,
          actualChangedPaths: materialized.actualChangedPaths,
        };
        const supplementalEpisode: TaskEpisodeV1 = {
          schemaVersion: 1,
          id: taskEpisodeId,
          repositoryId: definition.repository,
          repositorySnapshot: materialized.preTaskSnapshot,
          sessionHash: contentHash(
            `github:${definition.repository}:issue:${materialized.linkedIssue.number}`,
          ),
          lineageHash: contentHash(
            `github:${definition.repository}:issue:${materialized.linkedIssue.number}`,
          ),
          timestamp: new Date(materialized.mergedAt).toISOString(),
          split: "validation",
          currentRequest: materialized.taskText,
          source: "github",
        };
        const plausibleAreaIds = plausibleAreasForHardCase(
          supplementalEvidence,
          cards,
        );
        if (plausibleAreaIds.length < 2) continue;
        eligible.push({
          episode: supplementalEpisode,
          evidence: supplementalEvidence,
          plausibleAreaIds,
        });
        existingPulls.add(
          `${definition.repository}:${materialized.number}`,
        );
        existingIssues.add(issueKey);
        current += 1;
      }
      if (current >= quota) break;
    }
    if (current < quota) {
      throw new Error(
        `Only ${current}/${quota} natural ${stratum} hard cases could be collected`,
      );
    }
  }
  const selected: typeof eligible = [];
  for (const stratum of strata) {
    const candidates = eligible
      .filter((item) => item.evidence.samplingKind === stratum)
      .sort(
        (left, right) =>
          left.episode.repositoryId.localeCompare(
            right.episode.repositoryId,
          ) ||
          left.episode.timestamp.localeCompare(right.episode.timestamp) ||
          left.episode.id.localeCompare(right.episode.id),
      );
    const quota = quotas.get(stratum)!;
    const byRepository = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const group = byRepository.get(candidate.episode.repositoryId) ?? [];
      group.push(candidate);
      byRepository.set(candidate.episode.repositoryId, group);
    }
    const repositories = [...byRepository.keys()].sort();
    let cursor = 0;
    while (
      selected.filter(
        (item) => item.evidence.samplingKind === stratum,
      ).length < quota
    ) {
      const repository = repositories[cursor % repositories.length];
      const candidate = repository
        ? byRepository.get(repository)?.shift()
        : undefined;
      if (!candidate) {
        if (repository) {
          repositories.splice(cursor % repositories.length, 1);
        }
        if (repositories.length === 0) {
          throw new Error(
            `Only ${selected.filter((item) => item.evidence.samplingKind === stratum).length}/${quota} eligible ${stratum} hard cases`,
          );
        }
        continue;
      }
      selected.push(candidate);
      cursor += 1;
    }
  }
  const selectedEpisodes = selected.map((item) => ({
    ...item.episode,
    split: "validation" as const,
  }));
  const provenance = selected.map((item) => ({
    schemaVersion: 1,
    taskEpisodeId: item.episode.id,
    repositoryId: item.episode.repositoryId,
    sourceCohort: DIVERSE_PUBLIC_COHORT_VERSION,
    sourcePullRequestNumber: item.evidence.pullRequestNumber,
    sourceIssueNumber: item.evidence.linkedIssue.number,
    sourceSplit: item.episode.split,
    stratum: item.evidence.samplingKind,
    plausibleAreaIds: item.plausibleAreaIds,
    selectionPredatesModelInference: true,
    gates: {
      noRegisteredAreaName: true,
      noExactRepositoryPath: true,
      atLeastTwoPlausibleAreas: item.plausibleAreaIds.length >= 2,
      repositoryExplorationRequired: true,
      naturalTaskText: true,
    },
    offlineEvidencePolicy:
      "Plausibility and stratum use construction-only labels/paths. Do not expose this record to classifiers.",
  }));
  const counts = {
    total: selectedEpisodes.length,
    known: provenance.filter((item) => item.stratum === "known").length,
    multiArea: provenance.filter((item) => item.stratum === "multi_area")
      .length,
    naturalUnknown: provenance.filter(
      (item) => item.stratum === "natural_unknown",
    ).length,
    byRepository: Object.fromEntries(
      [...new Set(selectedEpisodes.map((episode) => episode.repositoryId))]
        .sort()
        .map((repositoryId) => [
          repositoryId,
          selectedEpisodes.filter(
            (episode) => episode.repositoryId === repositoryId,
          ).length,
        ]),
    ),
  };
  const output = path.resolve(input.outputDirectory);
  await writeJsonl(output, "episodes.jsonl", selectedEpisodes);
  await writeJsonl(output, "provenance.jsonl", provenance);
  await writeJson(output, "manifest.json", {
    schemaVersion: 1,
    specificationVersion: NATURAL_HARD_COHORT_VERSION,
    generatedAt: new Date().toISOString(),
    counts,
    selectionPolicy: {
      selectedBeforeLunaInference: true,
      modelFailureUsedForSelection: false,
      syntheticParaphrasesIncluded: false,
      directAreaNamesForbidden: true,
      exactRepositoryPathsForbidden: true,
      minimumPlausibleAreas: 2,
    },
    hashes: {
      episodes: contentHash(selectedEpisodes),
      provenance: contentHash(provenance),
    },
  });
  await writeFile(
    path.join(output, "audit.md"),
    [
      "# Cohort D — natural hard cases",
      "",
      `Frozen tasks: ${counts.total}`,
      `Known: ${counts.known}`,
      `Multi-area: ${counts.multiArea}`,
      `Natural open-set: ${counts.naturalUnknown}`,
      "",
      "All cases are natural linked-issue tasks selected before model inference. Each omits registered-area names and exact repository paths, has at least two plausible registered areas during offline audit, and requires repository exploration.",
      "",
      "Construction-only labels, changed paths, PRs, and issue relations are stored only in provenance/offline evidence and must not be passed to Sol or Luna.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
};

export const auditCohortSnapshotResolution = async (input: {
  cohortDirectory: string;
  repositoryPaths: Readonly<Record<string, string>>;
}): Promise<void> => {
  const episodes = await readJsonl<TaskEpisodeV1 | TaskEpisodeV2>(
    path.join(input.cohortDirectory, "episodes.jsonl"),
  );
  const repositories = [...new Set(episodes.map((episode) => episode.repositoryId))]
    .sort();
  const results: Array<{
    repositoryId: string;
    localRepositoryPath: string;
    originUrl: string;
    episodeCount: number;
    uniqueSnapshots: number;
    resolvedSnapshots: number;
    missingSnapshots: string[];
  }> = [];
  for (const repositoryId of repositories) {
    const localRepositoryPath = input.repositoryPaths[repositoryId];
    if (!localRepositoryPath) {
      throw new Error(`No local repository path configured for ${repositoryId}`);
    }
    const repositoryEpisodes = episodes.filter(
      (episode) => episode.repositoryId === repositoryId,
    );
    const snapshots = [
      ...new Set(
        repositoryEpisodes.map((episode) => episode.repositorySnapshot),
      ),
    ].sort();
    const missingSnapshots: string[] = [];
    for (const snapshot of snapshots) {
      try {
        await execFileAsync(
          "git",
          [
            "-C",
            localRepositoryPath,
            "cat-file",
            "-e",
            `${snapshot}^{commit}`,
          ],
          { encoding: "utf8" },
        );
      } catch {
        missingSnapshots.push(snapshot);
      }
    }
    const origin = await execFileAsync(
      "git",
      ["-C", localRepositoryPath, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    );
    results.push({
      repositoryId,
      localRepositoryPath,
      originUrl: origin.stdout.trim(),
      episodeCount: repositoryEpisodes.length,
      uniqueSnapshots: snapshots.length,
      resolvedSnapshots: snapshots.length - missingSnapshots.length,
      missingSnapshots,
    });
  }
  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cohortDirectory: path.resolve(input.cohortDirectory),
    counts: {
      episodes: episodes.length,
      uniqueSnapshots: results.reduce(
        (sum, result) => sum + result.uniqueSnapshots,
        0,
      ),
      resolvedSnapshots: results.reduce(
        (sum, result) => sum + result.resolvedSnapshots,
        0,
      ),
      missingSnapshots: results.reduce(
        (sum, result) => sum + result.missingSnapshots.length,
        0,
      ),
    },
    repositories: results,
    allResolved: results.every(
      (result) => result.missingSnapshots.length === 0,
    ),
  };
  await writeJson(
    path.resolve(input.cohortDirectory),
    "snapshot-resolution-audit.json",
    {
      ...audit,
      hash: contentHash(audit),
    },
  );
  if (!audit.allResolved) {
    throw new Error(
      `${audit.counts.missingSnapshots} cohort snapshots are unresolved`,
    );
  }
};
