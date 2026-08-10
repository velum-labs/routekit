import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

import { canonicalRateLimitWindowKey } from "./provider.js";
import type {
  AccountLimits,
  RateLimitDiagnostic,
  ResetCredit,
  ResetCreditSnapshot
} from "./types.js";

export type CooldownContext = {
  model?: string;
  windows?: string[];
};

type PersistedMemberState = {
  limits?: AccountLimits;
  coolingUntil?: number;
  cooldownRevision?: number;
  cooldownContext?: CooldownContext;
};

type PersistedTrackerFile = {
  rateLimitNormalizationVersion: 1;
  usageRefreshRequired?: true;
  members: Array<{ id: string } & PersistedMemberState>;
};

type TrackerStateRead = {
  state: Map<string, PersistedMemberState>;
  migrated: boolean;
  requiresRefresh: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedRateLimitWindow(
  value: unknown,
  observedAt: number,
  source: AccountLimits["source"],
  migration?: { required: boolean }
): AccountLimits["windows"][string] | undefined {
  if (!isRecord(value) || typeof value.utilization !== "number") return undefined;
  const windowObservedAt = typeof value.observedAt === "number" ? value.observedAt : observedAt;
  const windowSource =
    value.source === "headers" ||
    value.source === "response" ||
    value.source === "usage" ||
    value.source === "stream"
      ? value.source
      : source;
  if (
    migration !== undefined &&
    (typeof value.observedAt !== "number" || value.source !== windowSource)
  ) {
    migration.required = true;
  }
  return {
    utilization: value.utilization,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.resetsAt === "number" ? { resetsAt: value.resetsAt } : {}),
    ...(typeof value.windowSeconds === "number" ? { windowSeconds: value.windowSeconds } : {}),
    ...(typeof value.limitName === "string" ? { limitName: value.limitName } : {}),
    observedAt: windowObservedAt,
    source: windowSource
  };
}

function parsedResetCredit(value: unknown): ResetCredit | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  return {
    id: value.id,
    ...(typeof value.resetType === "string" ? { resetType: value.resetType } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.grantedAt === "number" && Number.isFinite(value.grantedAt)
      ? { grantedAt: value.grantedAt }
      : {}),
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? { expiresAt: value.expiresAt }
      : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {})
  };
}

function parsedResetCreditSnapshot(
  value: unknown,
  fallbackObservedAt?: number,
  migration?: { required: boolean }
): ResetCreditSnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.availableCount !== "number" ||
    !Number.isFinite(value.availableCount) ||
    value.availableCount < 0
  ) {
    return undefined;
  }
  let observedAt: number;
  if (typeof value.observedAt === "number" && Number.isFinite(value.observedAt)) {
    observedAt = value.observedAt;
  } else if (fallbackObservedAt !== undefined) {
    if (migration !== undefined) migration.required = true;
    observedAt = fallbackObservedAt;
  } else {
    return undefined;
  }
  if (value.credits !== undefined && !Array.isArray(value.credits)) return undefined;
  const credits = Array.isArray(value.credits)
    ? value.credits.flatMap((entry) => {
        const credit = parsedResetCredit(entry);
        return credit === undefined ? [] : [credit];
      })
    : undefined;
  if (
    Array.isArray(value.credits) &&
    credits !== undefined &&
    credits.length !== value.credits.length &&
    migration !== undefined
  ) {
    migration.required = true;
  }
  return {
    observedAt,
    availableCount: Math.floor(value.availableCount),
    ...(credits !== undefined ? { credits } : {})
  };
}

function parsedAccountLimits(
  value: unknown,
  mode?: SubscriptionMode,
  migration?: { required: boolean },
  discardWindows = false
): AccountLimits | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.windows) ||
    typeof value.observedAt !== "number" ||
    (value.source !== "headers" &&
      value.source !== "response" &&
      value.source !== "usage" &&
      value.source !== "stream")
  ) {
    return undefined;
  }
  let completeness: AccountLimits["completeness"];
  if (value.completeness === "snapshot" || value.completeness === "partial") {
    completeness = value.completeness;
  } else {
    if (migration !== undefined) migration.required = true;
    // Legacy `usage` state may already contain union-merged header windows.
    // Its provenance is irrecoverably ambiguous, so discard and re-probe.
    if (value.source === "usage") return undefined;
    completeness = "partial";
  }
  const windows = Object.create(null) as AccountLimits["windows"];
  if (!discardWindows) {
    for (const [key, raw] of Object.entries(value.windows)) {
      const window = parsedRateLimitWindow(raw, value.observedAt, value.source, migration);
      if (window === undefined) continue;
      const canonicalKey = mode === undefined ? key : canonicalRateLimitWindowKey(mode, key);
      if (canonicalKey !== key && migration !== undefined) migration.required = true;
      Object.defineProperty(windows, canonicalKey, {
        value: window,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  const resetCredits = parsedResetCreditSnapshot(value.resetCredits, value.observedAt, migration);
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.flatMap((entry): RateLimitDiagnostic[] => {
        if (
          !isRecord(entry) ||
          entry.code !== "invalid_utilization" ||
          typeof entry.window !== "string" ||
          (entry.field !== "utilization" && entry.field !== "used_percent")
        ) {
          if (migration !== undefined) migration.required = true;
          return [];
        }
        return [
          {
            code: "invalid_utilization",
            window: entry.window,
            field: entry.field
          }
        ];
      })
    : undefined;
  return {
    windows,
    ...(diagnostics !== undefined && diagnostics.length > 0 ? { diagnostics } : {}),
    observedAt: value.observedAt,
    source: value.source,
    completeness,
    ...(typeof value.planType === "string" ? { planType: value.planType } : {}),
    ...(isRecord(value.credits) ? { credits: value.credits } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {})
  };
}

function parsedMemberState(
  value: unknown,
  mode?: SubscriptionMode,
  migration?: { required: boolean },
  discardWindows = false
): PersistedMemberState | undefined {
  if (!isRecord(value)) return undefined;
  const limits = parsedAccountLimits(value.limits, mode, migration, discardWindows);
  const coolingUntil =
    typeof value.coolingUntil === "number" && Number.isFinite(value.coolingUntil)
      ? value.coolingUntil
      : undefined;
  let cooldownRevision =
    typeof value.cooldownRevision === "number" &&
    Number.isSafeInteger(value.cooldownRevision) &&
    value.cooldownRevision >= 0
      ? value.cooldownRevision
      : 0;
  if (coolingUntil !== undefined && cooldownRevision === 0) {
    cooldownRevision = 1;
    if (migration !== undefined) migration.required = true;
  }
  let cooldownContext: CooldownContext | undefined;
  if (isRecord(value.cooldownContext)) {
    const windows = Array.isArray(value.cooldownContext.windows)
      ? value.cooldownContext.windows.filter((item): item is string => typeof item === "string")
      : undefined;
    cooldownContext = {
      ...(typeof value.cooldownContext.model === "string"
        ? { model: value.cooldownContext.model }
        : {}),
      ...(windows !== undefined ? { windows } : {})
    };
  }
  if (limits === undefined && coolingUntil === undefined && cooldownRevision === 0) return {};
  return {
    ...(limits !== undefined ? { limits } : {}),
    ...(coolingUntil !== undefined ? { coolingUntil } : {}),
    ...(cooldownRevision > 0 ? { cooldownRevision } : {}),
    ...(cooldownContext !== undefined ? { cooldownContext } : {})
  };
}

function readTrackerState(path: string, mode?: SubscriptionMode): TrackerStateRead {
  const state = new Map<string, PersistedMemberState>();
  const migration = { required: false };
  if (!existsSync(path)) return { state, migrated: false, requiresRefresh: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { state, migrated: false, requiresRefresh: false };
    const requiresRefresh =
      mode === "codex" &&
      (parsed.usageRefreshRequired === true ||
        (parsed.rateLimitNormalizationVersion !== 1 &&
          Array.isArray(parsed.members) &&
          parsed.members.some((entry) => isRecord(entry) && entry.limits !== undefined)));
    if (requiresRefresh) migration.required = true;
    if (Array.isArray(parsed.members)) {
      for (const entry of parsed.members) {
        if (!isRecord(entry) || typeof entry.id !== "string") continue;
        const member = parsedMemberState(entry, mode, migration, requiresRefresh);
        if (member !== undefined) state.set(entry.id, member);
      }
      return { state, migrated: migration.required, requiresRefresh };
    }
    // One-time migration from the original object-keyed state format.
    if (isRecord(parsed.members)) {
      migration.required = true;
      for (const [id, raw] of Object.entries(parsed.members)) {
        const member = parsedMemberState(raw, mode, migration, mode === "codex");
        if (member !== undefined) state.set(id, member);
      }
    }
    return {
      state,
      migrated: migration.required,
      requiresRefresh: mode === "codex" && isRecord(parsed.members)
    };
  } catch {
    return { state, migrated: false, requiresRefresh: false };
  }
}

function mergeLimits(
  previous: AccountLimits | undefined,
  next: AccountLimits,
  mode?: SubscriptionMode
): AccountLimits {
  const windows = Object.create(null) as AccountLimits["windows"];
  const sources =
    next.completeness === "snapshot" ? [next.windows] : [previous?.windows, next.windows];
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, window] of Object.entries(source)) {
      Object.defineProperty(
        windows,
        mode === undefined ? key : canonicalRateLimitWindowKey(mode, key),
        {
          value: window,
          enumerable: true,
          configurable: true,
          writable: true
        }
      );
    }
  }
  const resetCredits = next.resetCredits ?? previous?.resetCredits;
  const merged =
    next.completeness === "snapshot"
      ? { ...next, windows }
      : {
          ...previous,
          ...next,
          windows,
          observedAt: next.observedAt,
          source: next.source
        };
  const { diagnostics: _previousDiagnostics, ...withoutDiagnostics } = merged;
  return {
    ...withoutDiagnostics,
    ...(next.diagnostics !== undefined ? { diagnostics: next.diagnostics } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {})
  };
}
type SharedTrackerState = {
  mode: SubscriptionMode | undefined;
  members: Map<string, PersistedMemberState>;
  requiresRefresh: boolean;
  /** Exact text this process last wrote, so external edits stay detectable. */
  lastPersisted: string | undefined;
};

/**
 * Trackers for one state file share mutable state process-wide. A daemon
 * reload runs the candidate router before the previous one drains, so
 * independent maps would let a candidate probe replace the whole file and
 * silently discard a cooldown the draining generation just wrote.
 */
const sharedTrackerStates = new Map<string, SharedTrackerState>();

function readStateFileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export class RateLimitTracker {
  readonly #statePath: string;
  readonly #mode: SubscriptionMode | undefined;
  readonly #shared: SharedTrackerState;
  readonly #state: Map<string, PersistedMemberState>;

  constructor(statePath: string, mode?: SubscriptionMode) {
    this.#statePath = resolve(statePath);
    this.#mode = mode;
    const shared = sharedTrackerStates.get(this.#statePath);
    if (shared !== undefined) {
      if (shared.mode !== mode) {
        throw new Error(`rate-limit tracker mode mismatch for ${this.#statePath}`);
      }
      this.#shared = shared;
      this.#state = shared.members;
      this.#adoptExternalState();
      return;
    }
    const loaded = readTrackerState(this.#statePath, mode);
    this.#state = loaded.state;
    this.#shared = {
      mode,
      members: this.#state,
      requiresRefresh: loaded.requiresRefresh,
      lastPersisted: readStateFileText(this.#statePath)
    };
    sharedTrackerStates.set(this.#statePath, this.#shared);
    if (loaded.migrated) this.#persist();
  }

  /**
   * Operators recover accounts by editing `.state.json` and reloading, so a
   * new generation must honor a file this process did not write. Shared
   * members are replaced in place to keep existing trackers consistent.
   */
  #adoptExternalState(): void {
    const text = readStateFileText(this.#statePath);
    if (text === this.#shared.lastPersisted) return;
    const loaded = readTrackerState(this.#statePath, this.#mode);
    this.#state.clear();
    for (const [id, member] of loaded.state) this.#state.set(id, member);
    this.#shared.requiresRefresh = loaded.requiresRefresh;
    this.#shared.lastPersisted = text;
    if (loaded.migrated) this.#persist();
  }

  limits(memberId: string): AccountLimits | undefined {
    return this.#state.get(memberId)?.limits;
  }

  requiresRefresh(): boolean {
    return this.#shared.requiresRefresh;
  }

  markRefreshCompleted(): void {
    if (!this.#shared.requiresRefresh) return;
    this.#shared.requiresRefresh = false;
    this.#persist();
  }

  coolingUntil(memberId: string): number | undefined {
    return this.#state.get(memberId)?.coolingUntil;
  }

  cooldownRevision(memberId: string): number {
    return this.#state.get(memberId)?.cooldownRevision ?? 0;
  }

  cooldownContext(memberId: string): CooldownContext | undefined {
    return this.#state.get(memberId)?.cooldownContext;
  }

  update(memberId: string, limits: AccountLimits): void {
    const member = this.#state.get(memberId) ?? {};
    member.limits = mergeLimits(member.limits, limits, this.#mode);
    this.#state.set(memberId, member);
    this.#persist();
  }

  cool(memberId: string, until: number, context?: CooldownContext): number {
    const member = this.#state.get(memberId) ?? {};
    member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
    member.coolingUntil = until;
    if (context === undefined) delete member.cooldownContext;
    else member.cooldownContext = context;
    this.#state.set(memberId, member);
    this.#persist();
    return member.cooldownRevision;
  }

  clearCooling(memberId: string, expectedRevision?: number): boolean {
    const member = this.#state.get(memberId);
    if (
      member === undefined ||
      member.coolingUntil === undefined ||
      (expectedRevision !== undefined && member.cooldownRevision !== expectedRevision)
    )
      return false;
    member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
    delete member.coolingUntil;
    delete member.cooldownContext;
    this.#persist();
    return true;
  }

  reconcileSnapshot(
    memberId: string,
    limits: AccountLimits,
    expectedCooldownRevision: number,
    recovered: boolean
  ): boolean {
    const member = this.#state.get(memberId) ?? {};
    member.limits = mergeLimits(member.limits, limits, this.#mode);
    const cleared =
      recovered &&
      limits.completeness === "snapshot" &&
      member.coolingUntil !== undefined &&
      (member.cooldownRevision ?? 0) === expectedCooldownRevision;
    if (cleared) {
      member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
      delete member.coolingUntil;
      delete member.cooldownContext;
    }
    this.#state.set(memberId, member);
    this.#persist();
    return cleared;
  }

  resetAfterRefresh(memberId: string, expectedCooldownRevision: number): boolean {
    const member = this.#state.get(memberId) ?? {};
    delete member.limits;
    const cleared = (member.cooldownRevision ?? 0) === expectedCooldownRevision;
    if (cleared) {
      member.cooldownRevision = (member.cooldownRevision ?? 0) + 1;
      delete member.coolingUntil;
      delete member.cooldownContext;
    }
    this.#state.set(memberId, member);
    this.#persist();
    return cleared;
  }

  renameMember(sourceId: string, targetId: string): void {
    const source = this.#state.get(sourceId);
    const removedSource = this.#state.delete(sourceId);
    const removedStaleTarget = this.#state.delete(targetId);
    if (source !== undefined) this.#state.set(targetId, source);
    if (removedSource || removedStaleTarget || source !== undefined) this.#persist();
  }

  #persist(): void {
    const file: PersistedTrackerFile = {
      rateLimitNormalizationVersion: 1,
      ...(this.#shared.requiresRefresh ? { usageRefreshRequired: true as const } : {}),
      members: [...this.#state].map(([id, member]) => ({ id, ...member }))
    };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    writeFileAtomic(this.#statePath, text, { mode: 0o600 });
    this.#shared.lastPersisted = text;
  }
}
