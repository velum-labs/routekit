#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const outputRoot = path.join(
  root,
  ".routekit-experiment-assets/onboarding-generalization-20260819/source"
);
const priorInventoryFile = path.join(
  root,
  ".routekit-experiment-assets/composition-20260818/input-inventory.json"
);
const repositories = ["backstage/backstage", "grafana/grafana", "kubernetes/kubernetes"];
const generationTasksPerRepository = 40;
const evaluationTasksPerRepository = 40;
const maximumPages = 4;
const mergedSince = "2026-07-01";
const historicalSearchStart = "2026-01-01";
const evaluationCandidateDetailsLimit = 120;
const generationCandidateDetailsLimit = 220;
const temporalEmbargoDays = 14;
const minimumDescriptionLength = 100;
const githubToken = execFileSync("gh", ["auth", "token"], {
  encoding: "utf8"
}).trim();

const codeExtension =
  /\.(?:c|cc|cpp|cs|css|go|graphql|h|hpp|html|java|js|jsx|kt|kts|lua|m|mm|php|proto|py|rb|rs|scala|scss|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|yaml|yml)$/iu;
const codeBasename =
  /(?:^|\/)(?:BUILD(?:\.bazel)?|CMakeLists\.txt|Containerfile|Dockerfile|Gemfile|Justfile|Makefile|Tiltfile|WORKSPACE)$/iu;
const nonCodePrefix =
  /^(?:\.changeset|beps|changelogs?|changes|docs?|examples?\/docs|licenses?|rfcs?|website\/docs)(?:\/|$)/iu;
const nonCodeExtension =
  /\.(?:adoc|avif|bmp|csv|gif|ico|jpeg|jpg|md|mdx|pdf|png|rst|svg|txt|webp)$/iu;
const automationTitle =
  /^(?:(?:chore|build)(?:\([^)]*\))?:\s*)?(?:bump|update|upgrade)\s+(?:dependencies|dependency|deps|version|images?|charts?)\b/iu;
const releaseTitle =
  /^(?:\[release-[^\]]+\]\s*)|^(?:(?:chore|build)(?:\([^)]*\))?:\s*)?(?:prepare\s+)?release(?:\s|:|$)|^version packages\b/iu;
const documentationTitle = /^(?:docs?|documentation)(?:\([^)]*\))?(?::|\s|$)/iu;
const dependencyTitle =
  /^(?:chore\()?deps(?:\([^)]*\))?(?::|\s)|^(?:chore|build)?(?:\([^)]*\))?:?\s*(?:bump|upgrade)\b/iu;
const cherryPickTitle = /automated cherry[- ]pick/iu;
const bumpTitle = /\bbump\b/iu;
const botLogin = /(?:\[bot\]$|dependabot|renovate|github-actions|mergify|backstage-bot)/iu;
const excludedLabels = /^(?:dependencies|dependency|release|automated pr)$/iu;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const normalizeWhitespace = (value) => value.replaceAll(/\s+/gu, " ").trim();
const normalizedTitle = (value) =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();

function ghJson(args, options = {}) {
  return JSON.parse(
    execFileSync("gh", ["api", ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      ...options
    })
  );
}

async function githubJson(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "x-github-api-version": "2022-11-28"
    },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${pathname} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function cleanBody(body) {
  return body
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/\r/gu, "")
    .split("\n")
    .filter((line) => !/^\s*[-*]\s*\[[ xX]\]\s*(?:I|This|The|Tests?|Docs?|Changelog)/u.test(line))
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, 3000);
}

function codingFile(file) {
  if (nonCodePrefix.test(file.path)) return false;
  if (nonCodeExtension.test(file.path)) return false;
  return codeExtension.test(file.path) || codeBasename.test(file.path);
}

function eligiblePullRequest(pullRequest, excludedNumbers) {
  const author = pullRequest.author;
  const body = cleanBody(pullRequest.body ?? "");
  const files = pullRequest.files?.nodes ?? [];
  const labels = (pullRequest.labels?.nodes ?? []).map((label) => label.name);
  const reasons = [];
  if (!pullRequest.mergedAt) reasons.push("not-merged");
  if (excludedNumbers.has(pullRequest.number)) reasons.push("prior-benchmark-task");
  if (!author || author.__typename === "Bot" || botLogin.test(author.login)) reasons.push("bot");
  if (automationTitle.test(pullRequest.title)) reasons.push("dependency-or-version-update");
  if (dependencyTitle.test(pullRequest.title)) reasons.push("dependency-or-version-update");
  if (bumpTitle.test(pullRequest.title)) reasons.push("dependency-or-version-update");
  if (releaseTitle.test(pullRequest.title)) reasons.push("release");
  if (documentationTitle.test(pullRequest.title)) reasons.push("documentation-title");
  if (cherryPickTitle.test(pullRequest.title)) reasons.push("automated-cherry-pick");
  if (labels.some((label) => excludedLabels.test(label))) reasons.push("automation-label");
  if (body.length < minimumDescriptionLength) reasons.push("empty-or-very-short-description");
  if (!files.some(codingFile)) {
    reasons.push(
      pullRequest.files?.pageInfo?.hasNextPage ? "no-code-in-first-30-files" : "docs-only"
    );
  }
  return { eligible: reasons.length === 0, reasons, body };
}

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return { digest: digest(bytes), size: bytes.length };
}

async function priorNumbersByRepository() {
  const inventory = JSON.parse(await readFile(priorInventoryFile, "utf8"));
  const result = new Map(repositories.map((repositoryId) => [repositoryId, new Set()]));
  for (const task of inventory.tasks) {
    const repositoryId = task.metadata?.repositoryId;
    const match = /-pr-(\d+)$/u.exec(task.id);
    if (match && result.has(repositoryId)) result.get(repositoryId).add(Number(match[1]));
  }
  return result;
}

function repositoryProfile(repositoryId) {
  const [owner, name] = repositoryId.split("/");
  const profileQuery = `
    query($owner:String!, $name:String!) {
      repository(owner:$owner, name:$name) {
        description
        primaryLanguage { name }
        languages(first:8, orderBy:{field:SIZE,direction:DESC}) {
          edges { size node { name } }
        }
        repositoryTopics(first:20) { nodes { topic { name } } }
        defaultBranchRef { name }
        licenseInfo { spdxId }
      }
    }`;
  const metadata = ghJson([
    "graphql",
    "-f",
    `query=${profileQuery}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`
  ]).data.repository;
  return {
    repositoryId,
    description: metadata.description,
    primaryLanguage: metadata.primaryLanguage?.name ?? null,
    languagesByBytes: Object.fromEntries(
      (metadata.languages?.edges ?? []).map((edge) => [edge.node.name, edge.size])
    ),
    topics: (metadata.repositoryTopics?.nodes ?? []).map((entry) => entry.topic.name).sort(),
    defaultBranch: metadata.defaultBranchRef?.name ?? null,
    license: metadata.licenseInfo?.spdxId ?? null
  };
}

async function collectPullRequests(repositoryId, mergedQualifier, detailsLimit) {
  const searchItems = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const queryText = encodeURIComponent(`repo:${repositoryId} is:pr is:merged ${mergedQualifier}`);
    const payload = await githubJson(
      `/search/issues?q=${queryText}&sort=created&order=desc&per_page=100&page=${page}`
    );
    searchItems.push(...payload.items);
    if (searchItems.length >= payload.total_count) break;
  }
  const candidates = searchItems
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body,
      mergedAt: item.pull_request?.merged_at,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      author: item.user
        ? { login: item.user.login, __typename: item.user.type === "Bot" ? "Bot" : "User" }
        : null,
      labels: { nodes: (item.labels ?? []).map((label) => ({ name: label.name })) }
    }))
    .filter((item) => item.mergedAt)
    .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt))
    .filter((item) => {
      const body = cleanBody(item.body ?? "");
      if (!item.author || item.author.__typename === "Bot" || botLogin.test(item.author.login)) {
        return false;
      }
      if (
        automationTitle.test(item.title) ||
        dependencyTitle.test(item.title) ||
        bumpTitle.test(item.title) ||
        releaseTitle.test(item.title) ||
        documentationTitle.test(item.title) ||
        cherryPickTitle.test(item.title)
      ) {
        return false;
      }
      if (body.length < minimumDescriptionLength) return false;
      return !(item.labels?.nodes ?? []).some((label) => excludedLabels.test(label.name));
    })
    .slice(0, detailsLimit);
  const [owner, name] = repositoryId.split("/");
  const hydrated = [];
  for (let start = 0; start < candidates.length; start += 50) {
    const batch = candidates.slice(start, start + 50);
    const selections = batch
      .map(
        (candidate, index) => `
        p${index}: pullRequest(number:${candidate.number}) {
          baseRefOid
          headRefOid
          additions
          deletions
          changedFiles
          files(first:60) {
            nodes { path additions deletions changeType }
            pageInfo { hasNextPage }
          }
        }`
      )
      .join("\n");
    const batchQuery = `query($owner:String!, $name:String!) {
      repository(owner:$owner, name:$name) { ${selections} }
    }`;
    const payload = ghJson([
      "graphql",
      "-f",
      `query=${batchQuery}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`
    ]);
    for (const [index, candidate] of batch.entries()) {
      const pullRequest = payload.data.repository[`p${index}`];
      if (!pullRequest) continue;
      hydrated.push({
        ...candidate,
        baseRefOid: pullRequest.baseRefOid,
        headRefOid: pullRequest.headRefOid,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changedFiles: pullRequest.changedFiles,
        files: pullRequest.files
      });
    }
  }
  return hydrated;
}

function freezeTask(repositoryId, pullRequest, body, split) {
  const taskText = [pullRequest.title.trim(), body].join("\n\n");
  return {
    taskId: `${repositoryId.replace("/", "-")}-heldout-pr-${pullRequest.number}`,
    repositoryId,
    split,
    pullRequestNumber: pullRequest.number,
    title: pullRequest.title.trim(),
    body,
    taskTextHash: digest(normalizeWhitespace(taskText)),
    createdAt: pullRequest.createdAt,
    mergedAt: pullRequest.mergedAt,
    baseRefOid: pullRequest.baseRefOid,
    headRefOid: pullRequest.headRefOid,
    authorLogin: pullRequest.author?.login ?? null,
    labels: (pullRequest.labels?.nodes ?? []).map((label) => label.name).sort(),
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changedFiles,
    changedFilesAuditOnly: (pullRequest.files?.nodes ?? []).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.changeType
    })),
    changedFilesAuditTruncated: pullRequest.files?.pageInfo?.hasNextPage === true,
    runtimePromptExposesChangedFiles: false
  };
}

const priorNumbers = await priorNumbersByRepository();
const repositoriesOutput = [];
const rejectionCounts = {};

for (const repositoryId of repositories) {
  const excluded = priorNumbers.get(repositoryId);
  const evaluationPullRequests = await collectPullRequests(
    repositoryId,
    `merged:>=${mergedSince}`,
    evaluationCandidateDetailsLimit
  );
  const evaluationEligible = [];
  const evaluationRejected = [];
  const evaluationTitles = new Set();
  for (const pullRequest of evaluationPullRequests.sort((left, right) =>
    right.mergedAt.localeCompare(left.mergedAt)
  )) {
    const result = eligiblePullRequest(pullRequest, excluded);
    const titleKey = normalizedTitle(pullRequest.title);
    if (evaluationTitles.has(titleKey)) {
      result.eligible = false;
      result.reasons.push("duplicate-title");
    }
    if (result.eligible) {
      evaluationTitles.add(titleKey);
      evaluationEligible.push({ pullRequest, body: result.body });
    } else {
      evaluationRejected.push({
        number: pullRequest.number,
        title: pullRequest.title,
        reasons: result.reasons
      });
    }
  }
  if (evaluationEligible.length < evaluationTasksPerRepository) {
    throw new Error(
      `${repositoryId} has only ${evaluationEligible.length} eligible evaluation PRs; need ${evaluationTasksPerRepository}`
    );
  }
  const evaluationSource = evaluationEligible.slice(0, evaluationTasksPerRepository);
  const evaluationStart = evaluationSource.at(-1).pullRequest.mergedAt;
  const embargoCutoff = new Date(
    new Date(evaluationStart).getTime() - temporalEmbargoDays * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  const generationRangeEnd = new Date(
    new Date(`${embargoCutoff}T00:00:00.000Z`).getTime() - 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  const generationPullRequests = await collectPullRequests(
    repositoryId,
    `merged:${historicalSearchStart}..${generationRangeEnd}`,
    generationCandidateDetailsLimit
  );
  const generationEligible = [];
  const generationRejected = [];
  const seenTitles = new Set(evaluationTitles);
  for (const pullRequest of generationPullRequests.sort((left, right) =>
    right.mergedAt.localeCompare(left.mergedAt)
  )) {
    const result = eligiblePullRequest(pullRequest, excluded);
    if (!(pullRequest.mergedAt < `${embargoCutoff}T00:00:00.000Z`)) {
      result.eligible = false;
      result.reasons.push("inside-temporal-embargo");
    }
    const titleKey = normalizedTitle(pullRequest.title);
    if (seenTitles.has(titleKey)) {
      result.eligible = false;
      result.reasons.push("duplicate-title-across-splits");
    }
    if (result.eligible) {
      seenTitles.add(titleKey);
      generationEligible.push({ pullRequest, body: result.body });
    } else {
      generationRejected.push({
        number: pullRequest.number,
        title: pullRequest.title,
        reasons: result.reasons
      });
    }
  }
  if (generationEligible.length < generationTasksPerRepository) {
    throw new Error(
      `${repositoryId} has only ${generationEligible.length} eligible pre-embargo generation PRs; need ${generationTasksPerRepository}`
    );
  }
  const generationSource = generationEligible.slice(0, generationTasksPerRepository);
  const generation = generationSource.map(({ pullRequest, body }) =>
    freezeTask(repositoryId, pullRequest, body, "generation")
  );
  const evaluation = evaluationSource.map(({ pullRequest, body }) =>
    freezeTask(repositoryId, pullRequest, body, "evaluation")
  );
  const generationIds = new Set(generation.map((task) => task.pullRequestNumber));
  const generationHashes = new Set(generation.map((task) => task.taskTextHash));
  const overlap = evaluation.filter(
    (task) => generationIds.has(task.pullRequestNumber) || generationHashes.has(task.taskTextHash)
  );
  if (overlap.length > 0) throw new Error(`${repositoryId} has generation/evaluation overlap`);
  const latestGeneration = generation
    .map((task) => task.mergedAt)
    .sort()
    .at(-1);
  const earliestEvaluation = evaluation.map((task) => task.mergedAt).sort()[0];
  if (!(latestGeneration < earliestEvaluation)) {
    throw new Error(`${repositoryId} chronological split is not strict`);
  }
  const gapDays =
    (new Date(earliestEvaluation).getTime() - new Date(latestGeneration).getTime()) /
    (24 * 60 * 60 * 1000);
  if (gapDays < temporalEmbargoDays) {
    throw new Error(`${repositoryId} temporal embargo is only ${gapDays.toFixed(2)} days`);
  }
  const rejected = [...evaluationRejected, ...generationRejected];
  rejectionCounts[repositoryId] = Object.fromEntries(
    rejected
      .flatMap((entry) => entry.reasons)
      .reduce((counts, reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1), new Map())
  );
  repositoriesOutput.push({
    repositoryId,
    profile: repositoryProfile(repositoryId),
    collection: {
      scannedMergedPullRequests: evaluationPullRequests.length + generationPullRequests.length,
      evaluationCandidatesHydrated: evaluationPullRequests.length,
      generationCandidatesHydrated: generationPullRequests.length,
      eligiblePullRequests: evaluationEligible.length + generationEligible.length,
      rejectedPullRequests: rejected.length,
      priorBenchmarkPullRequestsExcluded: excluded.size,
      rejectedSample: rejected.slice(0, 20)
    },
    temporalSplit: {
      strict: true,
      temporalEmbargoDays,
      generationSearchBefore: embargoCutoff,
      generationTasks: generation.length,
      evaluationTasks: evaluation.length,
      latestGenerationMergedAt: latestGeneration,
      earliestEvaluationMergedAt: earliestEvaluation,
      observedGapDays: Number(gapDays.toFixed(3)),
      generationEvaluationTaskOverlap: overlap.length
    },
    generation,
    evaluation
  });
}

const allGeneration = repositoriesOutput.flatMap((entry) => entry.generation);
const allEvaluation = repositoriesOutput.flatMap((entry) => entry.evaluation);
const inventory = {
  schemaVersion: 1,
  datasetId: "onboarding-generalization-source-3x40-v1",
  frozenAt: new Date().toISOString(),
  selectionPolicy: {
    repositories,
    searchWindow: `merged on or after ${mergedSince}`,
    historicalSearchStart,
    scannedMergedPullRequestsPerRepository: maximumPages * 100,
    evaluationCandidateDetailsPerRepository: evaluationCandidateDetailsLimit,
    generationCandidateDetailsPerRepository: generationCandidateDetailsLimit,
    temporalEmbargoDays,
    minimumDescriptionLength,
    generationTasksPerRepository,
    evaluationTasksPerRepository,
    split: "newest eligible PRs are evaluation; immediately preceding eligible PRs are generation",
    exclusions: [
      "bots and automation",
      "dependency/version bumps",
      "release PRs",
      "documentation-only changes",
      "empty or very short descriptions",
      "tasks already used by the earlier composition benchmark",
      "duplicate normalized titles"
    ],
    changedFilesUse: "audit and coding-task eligibility only; never included in model prompts"
  },
  safeguards: {
    strictTemporalSplit: true,
    generationEvaluationTaskOverlap: 0,
    heldoutTaskTextExcludedFromGeneration: true,
    changedFilesExcludedFromRuntimePrompt: true,
    priorBenchmarkTasksExcludedFromEvaluation: true,
    lockedTestIncluded: false
  },
  counts: {
    repositories: repositoriesOutput.length,
    generationTasks: allGeneration.length,
    evaluationTasks: allEvaluation.length
  },
  rejectionCounts,
  repositories: repositoriesOutput
};

const inventoryFile = path.join(outputRoot, "source-inventory.json");
const result = await writeJson(inventoryFile, inventory);
console.log(
  JSON.stringify(
    {
      ok: true,
      inventoryFile,
      inventoryHash: result.digest,
      repositories: repositoriesOutput.map((entry) => ({
        repositoryId: entry.repositoryId,
        scanned: entry.collection.scannedMergedPullRequests,
        eligible: entry.collection.eligiblePullRequests,
        generation: entry.generation.length,
        evaluation: entry.evaluation.length,
        latestGenerationMergedAt: entry.temporalSplit.latestGenerationMergedAt,
        earliestEvaluationMergedAt: entry.temporalSplit.earliestEvaluationMergedAt
      })),
      totalGenerationTasks: allGeneration.length,
      totalEvaluationTasks: allEvaluation.length
    },
    null,
    2
  )
);
