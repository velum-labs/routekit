import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

import { canonicalRateLimitWindowKey } from "./provider.js";
import {
  type CooldownContext,
  decodeRateLimitTrackerState,
  type PersistedMemberState,
  type PersistedTrackerFile,
  type TrackerStateRead
} from "./rate-limit-tracker-codec.js";
import type { AccountLimits } from "./types.js";

export type { CooldownContext } from "./rate-limit-tracker-codec.js";

function readTrackerState(path: string, mode?: SubscriptionMode): TrackerStateRead {
  try {
    return decodeRateLimitTrackerState(JSON.parse(readFileSync(path, "utf8")), mode);
  } catch {
    return { state: new Map(), migrated: false, requiresRefresh: false };
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
