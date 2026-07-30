import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

import {
  type JsonValue,
  parseReasoningSelection,
  type ReasoningSelection
} from "@velum-labs/routekit-contracts";
import { acquireLifecycleLock, randomId, writeFileAtomic } from "@velum-labs/routekit-runtime";

import { routekitHome } from "./config.js";

export const SESSION_REGISTRY_VERSION = 1 as const;
const SESSION_ID_PATTERN = /^rks_[a-z0-9]{24}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type SessionLifecycleStatus = "launching" | "resumable" | "stale" | "failed";
export type SessionTool = "codex" | "claude";

/** Structurally compatible with the harness-core ResumeCursor contract. */
export type SessionResumeCursor = { version: number; kind: string; data: JsonValue };
export type SessionRepositoryIdentity = { kind: "git-worktree" | "directory"; root: string };
export type SessionTargetIdentity = { kind: "local" } | { kind: "remote"; name: string };

export type RouteKitSession = {
  id: string;
  tool: SessionTool;
  resume: SessionResumeCursor;
  cwd: string;
  repository: SessionRepositoryIdentity;
  model: string;
  reasoning?: ReasoningSelection;
  target: SessionTargetIdentity;
  createdAt: string;
  updatedAt: string;
  status: SessionLifecycleStatus;
};

export type SessionRegistry = {
  version: typeof SESSION_REGISTRY_VERSION;
  sessions: RouteKitSession[];
};

export type CreateSessionInput = Omit<
  RouteKitSession,
  "id" | "cwd" | "repository" | "createdAt" | "updatedAt"
> & {
  id?: string;
  cwd: string;
  createdAt?: string;
  updatedAt?: string;
};

export type UpdateSessionInput = Partial<
  Pick<RouteKitSession, "resume" | "model" | "reasoning" | "target" | "status">
> & { updatedAt?: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const entry = object(value);
  return entry !== undefined && Object.values(entry).every(isJsonValue);
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function canonicalPath(path: string): string {
  try {
    return normalize(realpathSync(path));
  } catch (error) {
    throw new Error(
      `cannot identify RouteKit session directory ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function sessionRepositoryIdentity(cwd: string): {
  cwd: string;
  repository: SessionRepositoryIdentity;
} {
  const canonicalCwd = canonicalPath(resolve(cwd));
  try {
    const root = execFileSync("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (root.length > 0) {
      return {
        cwd: canonicalCwd,
        repository: { kind: "git-worktree", root: canonicalPath(root) }
      };
    }
  } catch {
    // A non-Git directory is its own repository identity.
  }
  return { cwd: canonicalCwd, repository: { kind: "directory", root: canonicalCwd } };
}

export function sessionsDirectory(): string {
  return join(routekitHome(), "sessions");
}

export function sessionRegistryPath(): string {
  return join(sessionsDirectory(), "registry.json");
}

export function sessionRegistryLockPath(): string {
  return join(sessionsDirectory(), "registry.lock");
}

export function createSessionId(): string {
  return randomId(24, "rks_");
}

function parseResumeCursor(value: unknown): SessionResumeCursor | undefined {
  const cursor = object(value);
  if (
    cursor === undefined ||
    !hasOnlyKeys(cursor, ["version", "kind", "data"]) ||
    !Number.isSafeInteger(cursor.version) ||
    (cursor.version as number) < 1 ||
    typeof cursor.kind !== "string" ||
    !NAME_PATTERN.test(cursor.kind) ||
    !isJsonValue(cursor.data)
  )
    return undefined;
  return { version: cursor.version as number, kind: cursor.kind, data: cursor.data as JsonValue };
}

function parseRepository(value: unknown): SessionRepositoryIdentity | undefined {
  const repository = object(value);
  if (
    repository === undefined ||
    !hasOnlyKeys(repository, ["kind", "root"]) ||
    (repository.kind !== "git-worktree" && repository.kind !== "directory") ||
    typeof repository.root !== "string" ||
    repository.root.length === 0
  )
    return undefined;
  return { kind: repository.kind, root: repository.root };
}

function parseTarget(value: unknown): SessionTargetIdentity | undefined {
  const target = object(value);
  if (target?.kind === "local" && hasOnlyKeys(target, ["kind"])) return { kind: "local" };
  if (
    target?.kind === "remote" &&
    hasOnlyKeys(target, ["kind", "name"]) &&
    typeof target.name === "string" &&
    NAME_PATTERN.test(target.name)
  )
    return { kind: "remote", name: target.name };
  return undefined;
}

function parseSession(value: unknown): RouteKitSession | undefined {
  const session = object(value);
  if (
    session === undefined ||
    !hasOnlyKeys(session, [
      "id",
      "tool",
      "resume",
      "cwd",
      "repository",
      "model",
      "reasoning",
      "target",
      "createdAt",
      "updatedAt",
      "status"
    ])
  )
    return undefined;
  const resume = parseResumeCursor(session.resume);
  const repository = parseRepository(session.repository);
  const target = parseTarget(session.target);
  const reasoning =
    session.reasoning === undefined ? undefined : parseReasoningSelection(session.reasoning);
  if (
    typeof session.id !== "string" ||
    !SESSION_ID_PATTERN.test(session.id) ||
    (session.tool !== "codex" && session.tool !== "claude") ||
    resume === undefined ||
    typeof session.cwd !== "string" ||
    session.cwd.length === 0 ||
    repository === undefined ||
    typeof session.model !== "string" ||
    session.model.length === 0 ||
    (reasoning !== undefined && !reasoning.ok) ||
    target === undefined ||
    !validIsoTimestamp(session.createdAt) ||
    !validIsoTimestamp(session.updatedAt) ||
    Date.parse(session.updatedAt) < Date.parse(session.createdAt) ||
    !["launching", "resumable", "stale", "failed"].includes(session.status as string)
  )
    return undefined;
  return {
    id: session.id,
    tool: session.tool,
    resume,
    cwd: session.cwd,
    repository,
    model: session.model,
    ...(reasoning !== undefined ? { reasoning: reasoning.selection } : {}),
    target,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status as SessionLifecycleStatus
  };
}

function registryError(message: string): Error {
  return new Error(
    `${message}: ${sessionRegistryPath()}. Move the file aside or remove it to let RouteKit create a new registry.`
  );
}

export function parseSessionRegistry(value: unknown): SessionRegistry {
  const registry = object(value);
  if (registry === undefined) throw registryError("RouteKit session registry is corrupt");
  if (registry.version !== SESSION_REGISTRY_VERSION) {
    throw registryError(
      `unsupported RouteKit session registry version ${JSON.stringify(registry.version)}`
    );
  }
  if (!hasOnlyKeys(registry, ["version", "sessions"]) || !Array.isArray(registry.sessions)) {
    throw registryError("RouteKit session registry is corrupt");
  }
  const sessions = registry.sessions.map(parseSession);
  if (sessions.some((session) => session === undefined)) {
    throw registryError("RouteKit session registry contains an invalid record");
  }
  const parsed = sessions as RouteKitSession[];
  if (new Set(parsed.map((session) => session.id)).size !== parsed.length) {
    throw registryError("RouteKit session registry contains duplicate session IDs");
  }
  return { version: SESSION_REGISTRY_VERSION, sessions: parsed };
}

export function readSessionRegistry(): SessionRegistry {
  const path = sessionRegistryPath();
  if (!existsSync(path)) return { version: SESSION_REGISTRY_VERSION, sessions: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw registryError("RouteKit session registry is not valid JSON");
  }
  return parseSessionRegistry(value);
}

function writeSessionRegistry(registry: SessionRegistry): void {
  const parsed = parseSessionRegistry(registry);
  parsed.sessions.sort((left, right) => left.id.localeCompare(right.id));
  const directory = sessionsDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileAtomic(sessionRegistryPath(), `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  chmodSync(sessionRegistryPath(), 0o600);
}

async function mutateRegistry<T>(
  mutation: (registry: SessionRegistry) => { registry: SessionRegistry; result: T }
): Promise<T> {
  mkdirSync(sessionsDirectory(), { recursive: true, mode: 0o700 });
  chmodSync(sessionsDirectory(), 0o700);
  const lock = await acquireLifecycleLock(sessionRegistryLockPath());
  try {
    chmodSync(sessionRegistryLockPath(), 0o600);
    const mutationResult = mutation(readSessionRegistry());
    writeSessionRegistry(mutationResult.registry);
    return mutationResult.result;
  } finally {
    lock.release();
  }
}

export function listSessions(): RouteKitSession[] {
  return readSessionRegistry().sessions;
}

export function getSession(id: string): RouteKitSession | undefined {
  return readSessionRegistry().sessions.find((session) => session.id === id);
}

export async function createSession(input: CreateSessionInput): Promise<RouteKitSession> {
  const identity = sessionRepositoryIdentity(input.cwd);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const session = parseSession({
    ...input,
    id: input.id ?? createSessionId(),
    ...identity,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  });
  if (session === undefined) throw new Error("invalid RouteKit session record");
  return await mutateRegistry((registry) => {
    if (registry.sessions.some((entry) => entry.id === session.id)) {
      throw new Error(`RouteKit session already exists: ${session.id}`);
    }
    return {
      registry: { ...registry, sessions: [...registry.sessions, session] },
      result: session
    };
  });
}

export async function updateSession(
  id: string,
  update: UpdateSessionInput
): Promise<RouteKitSession> {
  return await mutateRegistry((registry) => {
    const index = registry.sessions.findIndex((session) => session.id === id);
    if (index < 0) throw new Error(`unknown RouteKit session: ${id}`);
    const current = registry.sessions[index] as RouteKitSession;
    const next = parseSession({
      ...current,
      ...update,
      updatedAt: update.updatedAt ?? new Date().toISOString()
    });
    if (next === undefined) throw new Error(`invalid update for RouteKit session: ${id}`);
    const sessions = [...registry.sessions];
    sessions[index] = next;
    return { registry: { ...registry, sessions }, result: next };
  });
}

export async function deleteSession(id: string): Promise<boolean> {
  return await mutateRegistry((registry) => {
    const sessions = registry.sessions.filter((session) => session.id !== id);
    return {
      registry: { ...registry, sessions },
      result: sessions.length !== registry.sessions.length
    };
  });
}

export function newestResumableSession(
  tool: SessionTool,
  cwd: string,
  sessions: readonly RouteKitSession[] = listSessions()
): RouteKitSession | undefined {
  const { repository } = sessionRepositoryIdentity(cwd);
  return sessions
    .filter(
      (session) =>
        session.status === "resumable" &&
        session.tool === tool &&
        session.repository.kind === repository.kind &&
        session.repository.root === repository.root
    )
    .sort((left, right) => {
      const newest = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (newest !== 0) return newest;
      // IDs are ASCII-only. Code-point order is locale-independent and makes
      // equal-timestamp selection stable across machines and Node versions.
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })[0];
}
