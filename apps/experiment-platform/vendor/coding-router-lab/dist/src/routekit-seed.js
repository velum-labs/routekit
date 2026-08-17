import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./hash.js";
import { redactText } from "./validation.js";
const execFileAsync = promisify(execFile);
const starts = (...prefixes) => (file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
const includesSegment = (...segments) => (file) => segments.some((segment) => file.includes(segment));
export const ROUTEKIT_AREAS = [
    {
        areaId: "gateway-routing", name: "Gateway protocols and routing", description: "Provider-neutral request routing, OpenAI/Responses/Anthropic/Gemini/Bedrock wire translation, streaming, model calls, pricing, and provenance in the data-plane gateway.",
        inclusions: ["Gateway request and response codecs", "Provider egress and model routing", "Streaming and server-tool loops", "Call cost and provenance"],
        exclusions: ["Daemon lifecycle and control RPC", "Native coding-tool launcher configuration", "Subscription account enrollment"],
        pathAnchors: ["packages/gateway", "packages/router", "packages/contracts"], componentAnchors: ["gateway", "router", "provider adapters"], symbolAnchors: ["OpenAiBackend", "routing-core", "model-call-service"],
        codeSummaries: ["The gateway exposes compatible model APIs and translates them to provider-native wire formats.", "The router resolves canonical provider/model routes and records call provenance."],
        boundaryExamples: ["Adding an Anthropic stop-reason mapping belongs here; changing Claude Code's local config does not.", "Changing route selection belongs here; changing account login belongs to accounts and identity."],
        matches: starts("packages/gateway", "packages/router", "packages/contracts"),
    },
    {
        areaId: "accounts-identity", name: "Accounts, subscriptions, and identity", description: "Subscription credentials, provider accounts, account pools, usage limits, auth recovery, remote peer identity, tokens, and workload identity.",
        inclusions: ["Codex and Claude account enrollment", "Rate-limit and usage parsing", "Account pool selection and auth recovery", "Peer, token, and workload identity"],
        exclusions: ["Provider API wire translation", "CLI presentation without account behavior", "Generic deployment automation"],
        pathAnchors: ["packages/accounts", "apps/workload-identity", "packages/daemon/src/account-query-service.ts", "packages/daemon/src/token-application-service.ts"], componentAnchors: ["accounts", "subscription pools", "workload identity"], symbolAnchors: ["account pool", "token issue", "usage"],
        codeSummaries: ["Account adapters normalize subscription credentials, usage, and provider-specific rate limits.", "Identity surfaces authorize local, remote, and workload callers."],
        boundaryExamples: ["Parsing Codex used_percent belongs here; translating a Codex Responses stream belongs to gateway routing."],
        matches: (file) => starts("packages/accounts", "apps/workload-identity")(file) || starts("packages/daemon/src/account-application-options.ts", "packages/daemon/src/account-application-service.ts", "packages/daemon/src/account-enroll-service.ts", "packages/daemon/src/account-mutation-service.ts", "packages/daemon/src/token-store.ts", "packages/daemon/src/token-service.ts")(file),
    },
    {
        areaId: "daemon-control", name: "Daemon lifecycle and control plane", description: "Singleton daemon ownership, control protocol, runtime state, worker lifecycle, IPC, generations, health, and local/remote control execution.",
        inclusions: ["Daemon start, stop, and status", "Control RPC method contracts", "Worker spawn, supervision, and restart", "Runtime generations and health"],
        exclusions: ["Gateway provider codecs", "CLI-only formatting", "Cloud infrastructure definitions"],
        pathAnchors: ["packages/daemon", "packages/control", "packages/runtime"], componentAnchors: ["daemon", "control protocol", "runtime helpers"], symbolAnchors: ["daemon-state", "host-worker-session", "PRODUCT_OPERATIONS"],
        codeSummaries: ["The singleton daemon owns runtime state and serves a typed local control plane.", "Runtime helpers supervise child processes and lifecycle cleanup."],
        boundaryExamples: ["Making worker restart idempotent belongs here; changing an OpenAI codec belongs to gateway routing."],
        matches: starts("packages/daemon", "packages/control", "packages/runtime"),
    },
    {
        areaId: "cli-configuration", name: "CLI, setup, and configuration", description: "RouteKit commands, setup and onboarding flows, terminal UI, configuration loading/editing, completion, command telemetry paths, and user-facing diagnostics.",
        inclusions: ["CLI command trees and options", "Guided provider setup", "Configuration schemas and migrations", "Terminal prompts and status presentation"],
        exclusions: ["Native coding-tool serialization", "Gateway wire codecs", "Public documentation pages"],
        pathAnchors: ["packages/cli", "packages/cli-core", "packages/cli-ui", "packages/config", "packages/config-core"], componentAnchors: ["CLI", "setup", "configuration"], symbolAnchors: ["setup", "router-config", "command-path"],
        codeSummaries: ["The CLI configures providers and accounts, controls the daemon, and launches tools.", "Configuration packages own validated, atomic router configuration."],
        boundaryExamples: ["Adding a setup prompt belongs here; writing Codex config.toml belongs to coding-tool integrations."],
        matches: starts("packages/cli", "packages/cli-core", "packages/cli-ui", "packages/config", "packages/config-core"),
    },
    {
        areaId: "coding-tool-integrations", name: "Coding-tool integrations", description: "Codex, Claude Code, Cursor, and OpenCode launchers, installers, serializers, native session stores, model pickers, harness events, and client compatibility.",
        inclusions: ["Codex and Claude launch configuration", "Native client installers", "Tool model compatibility and pickers", "Harness protocol events and sessions"],
        exclusions: ["Gateway route execution", "Account credential enrollment", "General CLI setup unrelated to native tools"],
        pathAnchors: ["packages/tool-codex", "packages/tool-claude", "packages/tool-cursor", "packages/tool-opencode", "packages/harness-core", "packages/tools", "packages/tool-registry"], componentAnchors: ["Codex integration", "Claude Code integration", "tool registry"], symbolAnchors: ["driver", "launch", "install"],
        codeSummaries: ["Tool packages translate RouteKit routes into each coding agent's native configuration and session protocol."],
        boundaryExamples: ["Filtering incompatible OpenRouter models for Codex belongs here; routing the selected model request belongs to the gateway."],
        matches: starts("packages/tool-codex", "packages/tool-claude", "packages/tool-cursor", "packages/tool-opencode", "packages/harness-core", "packages/tools", "packages/tool-registry"),
    },
    {
        areaId: "documentation-release", name: "Documentation and release engineering", description: "Public documentation, generated API reference, README content, release automation, Changesets, changelogs, package verification, dependency automation, and publication workflows.",
        inclusions: ["Docs site and guides", "README and product copy", "Changesets and changelogs", "Release and dependency workflows"],
        exclusions: ["Production AWS runtime deployment", "Product code refactors with only incidental changesets", "Runtime telemetry implementation"],
        pathAnchors: ["apps/docs", "docs", ".changeset", ".github", "api-reports"], componentAnchors: ["documentation portal", "release pipeline"], symbolAnchors: ["changesets", "publint", "attw"],
        codeSummaries: ["The docs application publishes user and reference documentation.", "Release automation validates and publishes the fixed package group."],
        boundaryExamples: ["Repairing docs navigation belongs here; changing the daemon and adding its required changeset remains daemon work."],
        matches: starts("apps/docs", "docs", ".github", "api-reports", "packages/cli/CHANGELOG.md"),
    },
    {
        areaId: "cloud-deployment", name: "Cloud deployment and remote environments", description: "AWS/T3 deployment, workload runtime provisioning, IAM, remote installation, Docker/SSH testbeds, infrastructure artifacts, and operational deployment scripts.",
        inclusions: ["AWS IAM and runtime manifests", "T3 provisioning and launchers", "Remote install and SSH lifecycle", "Docker deployment fixtures"],
        exclusions: ["Local daemon internals", "Workload identity protocol implementation", "Public documentation without deployment code"],
        pathAnchors: ["deploy", "scripts", "apps/workload-identity", "test"], componentAnchors: ["AWS deployment", "T3", "remote environments"], symbolAnchors: ["workload verifier", "provision", "remote install"],
        codeSummaries: ["Deployment assets provision and operate RouteKit in hosted and remote environments."],
        boundaryExamples: ["Changing IAM role names belongs here; changing token verification logic belongs to accounts and identity."],
        matches: (file) => starts("deploy", "scripts", "tests/e2e", "tests/docker")(file) || includesSegment("aws", "t3", "remote-install", "provision")(file),
    },
];
const git = async (repository, args) => (await execFileAsync("git", ["-C", repository, ...args], { maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
const scoreAreas = (files) => ROUTEKIT_AREAS.map((area) => ({ areaId: area.areaId, score: files.filter(area.matches).length })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.areaId.localeCompare(b.areaId));
const assignedAreas = (files) => {
    const scores = scoreAreas(files);
    const top = scores[0];
    if (!top)
        return [];
    const selected = [top.areaId];
    const second = scores[1];
    if (second && second.score >= Math.max(2, Math.ceil(top.score * 0.45)))
        selected.push(second.areaId);
    return selected;
};
export const buildRouteKitSeed = async (pullsFile, repository) => {
    const excludedTitle = /^(?:chore:\s*version packages|build\(deps\):|bump (?:the )?npm-production group|release \d)/iu;
    const pulls = JSON.parse(await readFile(pullsFile, "utf8"))
        .filter((pr) => pr.merged_at && pr.merge_commit_sha && !excludedTitle.test(pr.title.trim()))
        .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at));
    const head = await git(repository, ["rev-parse", "origin/main"]);
    const profile = {
        schemaVersion: 1, repositoryId: "velum-labs/routekit", snapshot: head, name: "RouteKit", purpose: "A TypeScript CLI and singleton daemon exposing an authenticated, OpenAI-compatible gateway across coding subscriptions and API providers.",
        languages: ["TypeScript", "Shell", "MDX"], frameworks: ["Node.js", "pnpm", "Turborepo", "Next.js", "Fumadocs"], generatorVersion: "routekit-seed-v1",
        components: ROUTEKIT_AREAS.map((area) => ({ name: area.name, purpose: area.description, paths: area.pathAnchors })),
    };
    const episodes = [];
    const areaAssignments = new Map();
    for (const [index, pr] of pulls.entries()) {
        const files = (await git(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", `${pr.merge_commit_sha}^`, pr.merge_commit_sha])).split(/\r?\n/u).filter(Boolean);
        const parent = await git(repository, ["rev-parse", `${pr.merge_commit_sha}^`]);
        const cleaned = redactText(pr.title);
        const fraction = index / Math.max(1, pulls.length - 1);
        const split = fraction < 0.65 ? "reference" : fraction < 0.82 ? "validation" : "test";
        const id = `routekit-pr-${pr.number}`;
        episodes.push({ schemaVersion: 1, id, repositoryId: profile.repositoryId, repositorySnapshot: parent, sessionHash: contentHash(`github-pr:${pr.number}`), lineageHash: contentHash(`github-pr:${pr.number}`), timestamp: new Date(pr.merged_at).toISOString(), split, currentRequest: cleaned.text, source: "github", actualChangedPaths: files });
        areaAssignments.set(id, assignedAreas(files));
    }
    const cards = ROUTEKIT_AREAS.map((area) => {
        const positiveExamples = episodes
            .filter((episode) => episode.split === "reference" && areaAssignments.get(episode.id)?.includes(area.areaId))
            .sort((left, right) => {
            const leftScore = left.actualChangedPaths?.filter(area.matches).length ?? 0;
            const rightScore = right.actualChangedPaths?.filter(area.matches).length ?? 0;
            return rightScore - leftScore || left.timestamp.localeCompare(right.timestamp);
        });
        const positiveExampleIds = positiveExamples.slice(0, 12).map((episode) => episode.id);
        const representativeTasks = positiveExamples.slice(0, 8).map((episode) => episode.currentRequest);
        return {
            schemaVersion: 1, registryVersion: "routekit-area-registry-v1", repositoryId: profile.repositoryId, areaId: area.areaId, name: area.name, description: area.description,
            inclusions: area.inclusions, exclusions: area.exclusions, confusableAreaIds: ROUTEKIT_AREAS.filter((other) => other.areaId !== area.areaId && other.pathAnchors.some((anchor) => area.pathAnchors.includes(anchor))).map((other) => other.areaId),
            pathAnchors: area.pathAnchors, componentAnchors: area.componentAnchors, symbolAnchors: area.symbolAnchors, codeSummaries: [...area.codeSummaries, ...representativeTasks.map((task) => `Representative earlier task: ${task}`)], codeSnippets: [], positiveExampleIds, boundaryExamples: area.boundaryExamples,
            sourceHashes: [contentHash({ area: area.areaId, head })], generatorVersion: "routekit-seed-v1",
        };
    });
    return { profile, cards, episodes, areaAssignments };
};
export const writeRouteKitSeed = async (result, publicDir, privateDir) => {
    await mkdir(publicDir, { recursive: true });
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(publicDir, "repository-profile.json"), `${JSON.stringify(result.profile, null, 2)}\n`);
    await writeFile(path.join(publicDir, "area-cards.jsonl"), `${result.cards.map((item) => JSON.stringify(item)).join("\n")}\n`);
    await writeFile(path.join(privateDir, "task-episodes.jsonl"), `${result.episodes.map((item) => JSON.stringify(item)).join("\n")}\n`, { mode: 0o600 });
    await writeFile(path.join(privateDir, "heuristic-area-assignments.jsonl"), `${[...result.areaAssignments].map(([taskEpisodeId, selectedAreaIds]) => JSON.stringify({ taskEpisodeId, selectedAreaIds })).join("\n")}\n`, { mode: 0o600 });
};
