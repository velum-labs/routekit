import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./hash.ts";
import { redactText } from "./validation.ts";
import type { TaskEpisodeV2 } from "./types.ts";

interface SessionRecord { type?: string; timestamp?: string; payload?: Record<string, unknown> }
interface VisibleMessage { text: string; timestamp: string; index: number }
interface ToolCall { name: string; arguments: string; turnId?: string }
interface Diagnostic { text: string; index: number }
interface Turn {
  id: string;
  startedAt: string;
  startIndex: number;
  endIndex: number;
  status: "complete" | "aborted" | "incomplete";
  user?: VisibleMessage;
  assistants: VisibleMessage[];
  diagnostics: Diagnostic[];
}
interface SessionMetadata {
  id?: string;
  cwd?: string;
  source?: string;
  originator?: string;
  repositoryUrl?: string;
  commitHash?: string;
}

const walk = async (root: string): Promise<string[]> => {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(full);
  }
  return output;
};

const extractText = (payload: Record<string, unknown>): string => {
  if (typeof payload.message === "string") return payload.message;
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : typeof record.input_text === "string" ? record.input_text : typeof record.output_text === "string" ? record.output_text : "";
  }).filter(Boolean).join("\n");
};

const asString = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const metadataTurnId = (payload: Record<string, unknown>): string | undefined => {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  return metadata && typeof metadata === "object" ? asString((metadata as Record<string, unknown>).turn_id) : undefined;
};
const normalizeRepositoryUrl = (input: string): string => {
  let value = input.trim().replace(/\/+$/u, "").replace(/\.git$/iu, "");
  const scp = /^git@([^:]+):(.+)$/u.exec(value);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(value);
    value = `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+/u, "").toLowerCase()}`;
  } catch {
    value = value.toLowerCase();
  }
  return value;
};
const isValidSnapshot = (value: string | undefined): value is string => Boolean(value && /^[0-9a-f]{7,64}$/iu.test(value));
const isManagedOrInstruction = (text: string): boolean => /^\s*(?:#\s*AGENTS\.md\b|<INSTRUCTIONS>|<system_instruction>|<developer>|<environment_context>|<managed-context|<in-app-browser-context|You are \/root\b|You are a coding agent\b)/iu.test(text);
const isSubstantive = (text: string): boolean => text.trim().length >= 18 && !/^(?:ok(?:ay)?|yes|no|done|proceed|continue|do it|try again|go ahead|sounds good|that one|the second one)[.!?\s]*$/iu.test(text.trim());
export const isReferentialRequest = (text: string): boolean =>
  /^(?:ok(?:ay)?|yes|no|done|proceed|continue|do it|try again|go ahead|sounds good|that one|the second one)[.!?\s]*$/iu.test(text.trim())
  || /\b(?:use|apply|fix|change|implement|remove|add|retry|run)\s+(?:it|that|this|those|them|the (?:same|first|second|previous) (?:one|option|change))\b/iu.test(text)
  || /\b(?:as above|from before|previous option|same change|caused (?:that|the) (?:test )?failure|what you suggested|whatever caused that|I meant|not the)\b/iu.test(text);
const commandLooksDiagnostic = (name: string, argumentsText: string): boolean =>
  /(?:exec_command|write_stdin|shell|terminal)/iu.test(name) &&
  /(?:\btest\b|typecheck|lint|build|check|verify|pytest|jest|vitest|cargo test|go test|tsc\b)/iu.test(argumentsText);
const outputLooksDiagnostic = (output: string): boolean =>
  /(?:process exited with code [1-9]|command failed|tests? failed|failing|assertionerror|type error|error TS\d+|FAIL\b|not ok\b|ELIFECYCLE)/iu.test(output);
const boundedDiagnostic = (command: string, output: string): string => {
  const useful = output.split(/\r?\n/u).filter((line) =>
    /(?:error|fail|assert|not ok|process exited|tests?:|passed|typecheck|build|lint|warning)/iu.test(line),
  );
  const selected = (useful.length ? useful : output.split(/\r?\n/u).slice(-20)).join("\n").slice(0, 2_000);
  return `$ ${command.slice(0, 500)}\n${selected}`;
};

const parseSession = (text: string, fallbackTimestamp: string): { metadata: SessionMetadata; turns: Turn[]; messagesSeen: number; parseErrors: number } => {
  const metadata: SessionMetadata = {};
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  const calls = new Map<string, ToolCall>();
  let active: Turn | undefined;
  let messagesSeen = 0;
  let parseErrors = 0;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let record: SessionRecord;
    try { record = JSON.parse(line) as SessionRecord; } catch { parseErrors += 1; continue; }
    const payload = record.payload ?? {};
    const timestamp = record.timestamp ?? asString(payload.timestamp) ?? fallbackTimestamp;
    if (record.type === "session_meta") {
      const id = asString(payload.id) ?? asString(payload.session_id); if (id) metadata.id = id;
      const cwd = asString(payload.cwd); if (cwd) metadata.cwd = cwd;
      const source = asString(payload.source); if (source) metadata.source = source;
      const originator = asString(payload.originator); if (originator) metadata.originator = originator;
      const git = payload.git && typeof payload.git === "object" ? payload.git as Record<string, unknown> : {};
      const repositoryUrl = asString(git.repository_url); if (repositoryUrl) metadata.repositoryUrl = repositoryUrl;
      const commitHash = asString(git.commit_hash); if (commitHash) metadata.commitHash = commitHash;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_started") {
      const id = asString(payload.turn_id) ?? `turn-${index}`;
      active = { id, startedAt: timestamp, startIndex: index, endIndex: index, status: "incomplete", assistants: [], diagnostics: [] };
      turns.push(active); byId.set(id, active); continue;
    }
    if (record.type === "turn_context") {
      const id = asString(payload.turn_id);
      if (id && byId.has(id)) active = byId.get(id);
      continue;
    }
    if (record.type === "event_msg" && payload.type === "user_message") {
      messagesSeen += 1;
      if (active) {
        const raw = extractText(payload);
        if (raw.trim()) active.user = { text: raw, timestamp, index };
      }
      continue;
    }
    if (record.type === "event_msg" && payload.type === "agent_message") {
      messagesSeen += 1;
      const raw = extractText(payload);
      if (active && raw.trim()) active.assistants.push({ text: raw, timestamp, index });
      continue;
    }
    if (record.type === "response_item" && payload.type === "function_call") {
      const callId = asString(payload.call_id);
      const turnId = metadataTurnId(payload);
      if (callId) calls.set(callId, { name: asString(payload.name) ?? "tool", arguments: asString(payload.arguments) ?? "", ...(turnId ? { turnId } : {}) });
      continue;
    }
    if (record.type === "response_item" && payload.type === "function_call_output") {
      const callId = asString(payload.call_id);
      const call = callId ? calls.get(callId) : undefined;
      const output = asString(payload.output) ?? "";
      const turn = call?.turnId ? byId.get(call.turnId) : active;
      if (call && turn && output && (commandLooksDiagnostic(call.name, call.arguments) || outputLooksDiagnostic(output))) {
        turn.diagnostics.push({ text: boundedDiagnostic(call.arguments || call.name, output), index });
      }
      continue;
    }
    if (record.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      const id = asString(payload.turn_id);
      const turn = (id ? byId.get(id) : undefined) ?? active;
      if (turn) {
        turn.status = payload.type === "task_complete" ? "complete" : "aborted";
        turn.endIndex = index;
        if (active?.id === turn.id) active = undefined;
      }
    }
  }
  if (active) active.endIndex = Math.max(active.endIndex, text.split(/\r?\n/u).length - 1);
  return { metadata, turns, messagesSeen, parseErrors };
};

export interface CollectCodexOptions {
  codexHome: string;
  repositoryId: string;
  userId: string;
  repositoryUrl?: string;
  repositoryRoot?: string;
  repositorySnapshotFallback?: string;
  since?: string;
  includeAborted?: boolean;
}
export interface CollectionDiagnostics {
  collectorVersion: "codex-v2";
  generatedAt: string;
  targetRepositoryId: string;
  targetRepositoryUrl?: string;
  filesScanned: number;
  sessionsAccepted: number;
  sessionsRejectedRepository: number;
  sessionsRejectedSnapshot: number;
  sessionsRejectedNoTurns: number;
  messagesSeen: number;
  turnsSeen: number;
  episodesReconstructed: number;
  abortedTurnsExcluded: number;
  incompleteTurnsExcluded: number;
  managedMessagesExcluded: number;
  emptyAfterRedaction: number;
  redactions: number;
  parseErrors: number;
  snapshotFromMetadata: number;
  snapshotFromFallback: number;
  repositoryMatches: { url: number; cwd: number };
  sourceDistribution: Record<string, number>;
  originatorDistribution: Record<string, number>;
}
export interface CollectCodexResult { episodes: TaskEpisodeV2[]; diagnostics: CollectionDiagnostics }

export const collectCodexEpisodes = async (options: CollectCodexOptions): Promise<CollectCodexResult> => {
  const roots = [path.join(options.codexHome, "sessions"), path.join(options.codexHome, "archived_sessions")];
  const files: string[] = [];
  for (const root of roots) { try { files.push(...await walk(root)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  const episodes: TaskEpisodeV2[] = [];
  const diagnostics: CollectionDiagnostics = {
    collectorVersion: "codex-v2", generatedAt: new Date().toISOString(), targetRepositoryId: options.repositoryId,
    ...(options.repositoryUrl ? { targetRepositoryUrl: normalizeRepositoryUrl(options.repositoryUrl) } : {}),
    filesScanned: files.length, sessionsAccepted: 0, sessionsRejectedRepository: 0, sessionsRejectedSnapshot: 0,
    sessionsRejectedNoTurns: 0, messagesSeen: 0, turnsSeen: 0, episodesReconstructed: 0,
    abortedTurnsExcluded: 0, incompleteTurnsExcluded: 0, managedMessagesExcluded: 0,
    emptyAfterRedaction: 0, redactions: 0, parseErrors: 0, snapshotFromMetadata: 0, snapshotFromFallback: 0,
    repositoryMatches: { url: 0, cwd: 0 }, sourceDistribution: {}, originatorDistribution: {},
  };
  for (const file of files.sort()) {
    const raw = await readFile(file, "utf8");
    const parsed = parseSession(raw, new Date().toISOString());
    diagnostics.messagesSeen += parsed.messagesSeen; diagnostics.turnsSeen += parsed.turns.length; diagnostics.parseErrors += parsed.parseErrors;
    if (parsed.turns.length === 0) { diagnostics.sessionsRejectedNoTurns += 1; continue; }
    const expectedUrl = options.repositoryUrl ? normalizeRepositoryUrl(options.repositoryUrl) : undefined;
    const actualUrl = parsed.metadata.repositoryUrl ? normalizeRepositoryUrl(parsed.metadata.repositoryUrl) : undefined;
    const root = options.repositoryRoot ? path.resolve(options.repositoryRoot) : undefined;
    const cwd = parsed.metadata.cwd ? path.resolve(parsed.metadata.cwd) : undefined;
    const urlMatch = Boolean(expectedUrl && actualUrl === expectedUrl);
    const cwdMatch = Boolean(root && cwd && (cwd === root || cwd.startsWith(`${root}${path.sep}`)));
    if (!urlMatch && !cwdMatch) { diagnostics.sessionsRejectedRepository += 1; continue; }
    const repositoryMatch: "url" | "cwd" = urlMatch ? "url" : "cwd";
    diagnostics.repositoryMatches[repositoryMatch] += 1;
    const metadataSnapshot = isValidSnapshot(parsed.metadata.commitHash) ? parsed.metadata.commitHash : undefined;
    const fallbackSnapshot = isValidSnapshot(options.repositorySnapshotFallback) ? options.repositorySnapshotFallback : undefined;
    const repositorySnapshot = metadataSnapshot ?? fallbackSnapshot;
    if (!repositorySnapshot) { diagnostics.sessionsRejectedSnapshot += 1; continue; }
    const snapshotSource = metadataSnapshot ? "session_meta" : "provided_fallback";
    if (metadataSnapshot) diagnostics.snapshotFromMetadata += 1; else diagnostics.snapshotFromFallback += 1;
    diagnostics.sessionsAccepted += 1;
    const source = parsed.metadata.source ?? "unknown"; const originator = parsed.metadata.originator ?? "unknown";
    diagnostics.sourceDistribution[source] = (diagnostics.sourceDistribution[source] ?? 0) + 1;
    diagnostics.originatorDistribution[originator] = (diagnostics.originatorDistribution[originator] ?? 0) + 1;
    const sessionHash = contentHash(path.relative(options.codexHome, file));
    const sessionIdHash = contentHash(parsed.metadata.id ?? sessionHash);
    let lastAnchor: { text: string; turnId: string; timestamp: string } | undefined;
    let priorTaskUsers: string[] = [];
    let previousCompleted: Turn | undefined;
    for (const turn of parsed.turns) {
      if (turn.status === "aborted" && !options.includeAborted) { diagnostics.abortedTurnsExcluded += 1; continue; }
      if (turn.status === "incomplete") { diagnostics.incompleteTurnsExcluded += 1; continue; }
      const message = turn.user;
      if (!message) { if (turn.status === "complete") previousCompleted = turn; continue; }
      if (isManagedOrInstruction(message.text)) { diagnostics.managedMessagesExcluded += 1; continue; }
      const cleaned = redactText(message.text); diagnostics.redactions += cleaned.redactions;
      if (!cleaned.text.trim() || /^\[REDACTED MANAGED CONTEXT\]$/u.test(cleaned.text.trim())) { diagnostics.emptyAfterRedaction += 1; continue; }
      const timestamp = new Date(message.timestamp).toISOString();
      if (options.since && timestamp < new Date(options.since).toISOString()) continue;
      const referential = isReferentialRequest(cleaned.text);
      const previousAssistant = referential ? previousCompleted?.assistants.at(-1) : undefined;
      const assistantClean = previousAssistant ? redactText(previousAssistant.text) : undefined;
      if (assistantClean) diagnostics.redactions += assistantClean.redactions;
      const diagnosticRaw = referential ? previousCompleted?.diagnostics.at(-1)?.text : undefined;
      const diagnosticClean = diagnosticRaw ? redactText(diagnosticRaw) : undefined;
      if (diagnosticClean) diagnostics.redactions += diagnosticClean.redactions;
      const substantive = isSubstantive(cleaned.text);
      const anchor = referential ? lastAnchor : undefined;
      const lineageSeed = referential ? (lastAnchor?.turnId ?? turn.id) : turn.id;
      const lineageHash = contentHash(`${sessionHash}:${lineageSeed}`);
      const id = `codex-${contentHash(`${sessionHash}:${turn.id}:${cleaned.text}`).slice(0, 20)}`;
      const redactionCount = cleaned.redactions + (assistantClean?.redactions ?? 0) + (diagnosticClean?.redactions ?? 0);
      const earlier = referential ? priorTaskUsers.slice(-2) : [];
      episodes.push({
        schemaVersion: 2,
        id,
        repositoryId: options.repositoryId,
        repositorySnapshot,
        sessionHash,
        lineageHash,
        timestamp,
        split: "reference",
        currentRequest: cleaned.text,
        ...(anchor ? { taskAnchor: anchor.text } : {}),
        ...(assistantClean?.text.trim() ? { precedingAssistant: assistantClean.text } : {}),
        ...(earlier.length ? { earlierUserContext: earlier } : {}),
        ...(diagnosticClean?.text.trim() ? { relevantDiagnostic: diagnosticClean.text } : {}),
        source: "codex",
        provenance: {
          collectorVersion: "codex-v2", userIdHash: contentHash(options.userId), sessionIdHash, turnId: turn.id,
          sessionRelativePath: path.relative(options.codexHome, file),
          ...(parsed.metadata.source ? { sessionSource: parsed.metadata.source } : {}),
          ...(parsed.metadata.originator ? { originatorId: parsed.metadata.originator } : {}),
          ...(actualUrl ? { repositoryUrl: actualUrl } : {}),
          repositoryMatch, snapshotSource, turnStatus: turn.status,
          recordStart: turn.startIndex, recordEnd: turn.endIndex, redactionCount,
          context: {
            hasTaskAnchor: Boolean(anchor), hasPrecedingAssistant: Boolean(assistantClean?.text.trim()),
            hasEarlierUserContext: earlier.length > 0, hasRelevantDiagnostic: Boolean(diagnosticClean?.text.trim()),
            isReferentialRequest: referential,
          },
        },
      });
      if (referential) priorTaskUsers.push(cleaned.text);
      else priorTaskUsers = [cleaned.text];
      if (!referential && substantive) lastAnchor = { text: cleaned.text, turnId: turn.id, timestamp };
      if (turn.status === "complete") previousCompleted = turn;
    }
  }
  diagnostics.episodesReconstructed = episodes.length;
  return { episodes, diagnostics };
};

export { normalizeRepositoryUrl };
