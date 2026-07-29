import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  isRetryableProviderFailure,
  type ModelReasoningCapabilities,
  ProviderFailureError
} from "@velum-labs/routekit-contracts";
import type {
  BackendResponseMode,
  CapacityLease,
  DiscoveredModel
} from "@velum-labs/routekit-gateway";
import { CapacityPool, SseDecoder, SseParseError } from "@velum-labs/routekit-gateway";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { writeFileAtomic } from "@velum-labs/routekit-runtime";

import type { SubscriptionAccountSource } from "./account-source.js";
import { resolveSubscriptionAccounts } from "./account-source.js";
import { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
import {
  hasUsableCredits,
  isOverSwitchThreshold,
  isPoolEligible,
  memberHeadroom,
  poolReadiness,
  quotaAdmissionReasons
} from "./admission.js";
import { subscriptionCredentialLabel } from "./credentials.js";
import type { ConsumeResetCreditResult } from "./provider.js";
import { canonicalRateLimitWindowKey, type SubscriptionProvider } from "./provider.js";
import type {
  AccountLimits,
  ResetCredit,
  ResetCreditSnapshot,
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionFailure,
  SubscriptionMemberStatus,
  SubscriptionSelectionStrategy
} from "./types.js";

export type SubscriptionAccountSetOptions = {
  mode: SubscriptionMode;
  activity?: AccountActivityCoordinator;
  source?: SubscriptionAccountSource;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  refreshSkewSeconds?: number;
  fallbackCooldownSeconds?: number;
  /** @internal Deterministic scheduling seam for acquisition race tests. */
  beforeAcquisitionRevalidation?: (member: { label: string }) => Promise<void>;
};

export type SubscriptionExecutionObserver = {
  onAttempt?(account: { seat: string }): void;
  /** Original downstream mode; providers may independently force upstream SSE. */
  responseMode?: BackendResponseMode;
};

export type RedeemResetCreditInput = {
  label: string;
  creditId?: string;
  redeemRequestId?: string;
};

export type RedeemResetCreditResult = ConsumeResetCreditResult & {
  label: string;
  mode: SubscriptionMode;
};

type CooldownContext = {
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
  members: Array<{ id: string } & PersistedMemberState>;
};

type TrackerStateRead = {
  state: Map<string, PersistedMemberState>;
  migrated: boolean;
};

type PoolMember = {
  id: string;
  label: string;
  sourcePath: string;
  credential: SubscriptionCredential;
  models: Set<string>;
  coolingUntil?: number;
  cooldownRevision: number;
  lastUsed: number;
  inFlight: number;
  switchedAt: number;
  forcedRefreshAt?: number;
};

const DEFAULT_SWITCH_THRESHOLD = 0.9;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 300;
const FORCED_REFRESH_COOLDOWN_MS = 300_000;
const RAMP_WINDOW_MS = 30_000;
const RAMP_STEP_MS = 250;
export const SUBSCRIPTION_SSE_BUFFER_CAP_BYTES = 1024 * 1024;
const ATTRIBUTION_SEAT_KEY = randomBytes(32);

function attributionSeat(label: string): string {
  return `seat_${createHmac("sha256", ATTRIBUTION_SEAT_KEY)
    .update(label)
    .digest("hex")
    .slice(0, 16)}`;
}

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
  migration?: { required: boolean }
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
  const resetCredits = parsedResetCreditSnapshot(value.resetCredits, value.observedAt, migration);
  return {
    windows,
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
  migration?: { required: boolean }
): PersistedMemberState | undefined {
  if (!isRecord(value)) return undefined;
  const limits = parsedAccountLimits(value.limits, mode, migration);
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
  if (!existsSync(path)) return { state, migrated: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { state, migrated: false };
    if (Array.isArray(parsed.members)) {
      for (const entry of parsed.members) {
        if (!isRecord(entry) || typeof entry.id !== "string") continue;
        const member = parsedMemberState(entry, mode, migration);
        if (member !== undefined) state.set(entry.id, member);
      }
      return { state, migrated: migration.required };
    }
    // One-time migration from the original object-keyed state format.
    if (isRecord(parsed.members)) {
      migration.required = true;
      for (const [id, raw] of Object.entries(parsed.members)) {
        const member = parsedMemberState(raw, mode, migration);
        if (member !== undefined) state.set(id, member);
      }
    }
    return { state, migrated: migration.required };
  } catch {
    return { state, migrated: false };
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
  return {
    ...merged,
    ...(resetCredits !== undefined ? { resetCredits } : {})
  };
}

type SharedTrackerState = {
  mode: SubscriptionMode | undefined;
  members: Map<string, PersistedMemberState>;
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
    this.#shared.lastPersisted = text;
    if (loaded.migrated) this.#persist();
  }

  limits(memberId: string): AccountLimits | undefined {
    return this.#state.get(memberId)?.limits;
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
      members: [...this.#state].map(([id, member]) => ({ id, ...member }))
    };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    writeFileAtomic(this.#statePath, text, { mode: 0o600 });
    this.#shared.lastPersisted = text;
  }
}

export class SubscriptionAccountSetExhaustedError extends ProviderFailureError {
  readonly resetAt: number | undefined;

  constructor(mode: SubscriptionMode, resetAt?: number) {
    const message =
      resetAt === undefined
        ? `all ${mode} subscription pool members are unavailable`
        : `all ${mode} subscription pool members are unavailable until ${new Date(resetAt * 1000).toISOString()}`;
    super({
      category: "quota_exhausted",
      message,
      ...(resetAt !== undefined ? { resetsAt: resetAt } : {})
    });
    this.resetAt = resetAt;
  }
}

export class SubscriptionAccountSet {
  readonly #provider: SubscriptionProvider;
  readonly #options: Required<
    Pick<
      SubscriptionAccountSetOptions,
      "strategy" | "switchThreshold" | "refreshSkewSeconds" | "fallbackCooldownSeconds"
    >
  > &
    SubscriptionAccountSetOptions;
  readonly #members: PoolMember[];
  readonly #capacityPool: CapacityPool<PoolMember> | undefined;
  readonly #tracker: RateLimitTracker;
  readonly #activity: AccountActivityCoordinator;
  readonly #refreshes = new Map<string, Promise<void>>();
  readonly #reasoning = new Map<string, ModelReasoningCapabilities>();
  #usageProbe: Promise<void> | undefined;
  #lastUsageProbeAt: number | undefined;
  #activeId: string | undefined;
  #catalogReady = false;
  #probeTimer: NodeJS.Timeout | undefined;
  #closed = false;

  private constructor(
    provider: SubscriptionProvider,
    options: SubscriptionAccountSetOptions,
    members: PoolMember[],
    tracker: RateLimitTracker
  ) {
    this.#provider = provider;
    this.#options = {
      ...options,
      strategy: options.strategy ?? "sticky",
      switchThreshold: options.switchThreshold ?? DEFAULT_SWITCH_THRESHOLD,
      refreshSkewSeconds: options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS,
      fallbackCooldownSeconds: options.fallbackCooldownSeconds ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS
    };
    this.#members = members;
    this.#capacityPool =
      members.length === 0
        ? undefined
        : new CapacityPool(
            members.map((member) => ({ id: member.id, value: member })),
            { strategy: this.#options.strategy }
          );
    this.#tracker = tracker;
    this.#activity = options.activity ?? new AccountActivityCoordinator();
  }

  static async open(
    provider: SubscriptionProvider,
    options: SubscriptionAccountSetOptions
  ): Promise<SubscriptionAccountSet> {
    const source = options.source ?? { kind: "auto" as const };
    const accounts = await resolveSubscriptionAccounts(options.mode, source);
    const tracker = new RateLimitTracker(
      join(accounts.stateDirectory, ".state.json"),
      provider.mode
    );
    const members: PoolMember[] = [];
    for (const sourcePath of accounts.paths) {
      try {
        const credential = await provider.loadCredential(sourcePath);
        const id = subscriptionCredentialLabel(sourcePath);
        members.push({
          id,
          label: id,
          sourcePath,
          credential,
          models: new Set(),
          ...(tracker.coolingUntil(id) !== undefined
            ? { coolingUntil: tracker.coolingUntil(id) }
            : {}),
          cooldownRevision: tracker.cooldownRevision(id),
          lastUsed: 0,
          inFlight: 0,
          switchedAt: 0
        });
      } catch {
        // A broken member remains visible on disk for `proxy status`, but is
        // excluded from serving until the operator re-enrolls it.
      }
    }
    const accountSet = new SubscriptionAccountSet(provider, options, members, tracker);
    accountSet.#startProbe();
    return accountSet;
  }

  get mode(): SubscriptionMode {
    return this.#provider.mode;
  }

  get size(): number {
    return this.#members.length;
  }

  snapshot(): SubscriptionAccountSetSnapshot {
    return {
      mode: this.mode,
      strategy: this.#options.strategy,
      switchThreshold: this.#options.switchThreshold,
      members: this.#members.map((member) => this.#memberStatus(member))
    };
  }

  statusSnapshot(): SubscriptionAccountSetSnapshot {
    const snapshot = this.snapshot();
    const now = Date.now() / 1000;
    return {
      ...snapshot,
      members: snapshot.members.map((status) => {
        const member = this.#members.find((candidate) => candidate.id === status.id)!;
        const credentialValid =
          member.credential.accessToken.length > 0 &&
          (member.credential.expiresAt === undefined ||
            member.credential.expiresAt > Date.now() / 1000 ||
            (member.credential.refreshToken?.length ?? 0) > 0);
        const readiness = poolReadiness({
          limits: this.#tracker.limits(member.id),
          switchThreshold: this.#options.switchThreshold,
          ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
          ...(member.credential.expiresAt !== undefined
            ? { credentialExpiresAt: member.credential.expiresAt }
            : {}),
          hasRefreshToken: member.credential.refreshToken !== undefined,
          catalogReady: this.#catalogReady,
          models: [...member.models],
          now,
          isWindowRelevant: (key, limitName) => this.#windowRelevant(key, limitName, undefined)
        });
        const readinessReasons = credentialValid
          ? readiness.reasons
          : member.credential.expiresAt !== undefined && member.credential.expiresAt <= now
            ? readiness.reasons
            : [{ code: "credential_invalid" as const }, ...readiness.reasons];
        return {
          ...status,
          credentialValid,
          poolEligible: readiness.eligible,
          relayReady: credentialValid && readiness.eligible,
          readinessReasons
        };
      })
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly string[]> {
    const previousReasoning = new Map(this.#reasoning);
    this.#reasoning.clear();
    const discoveries = await Promise.allSettled(
      this.#members.map(async (member) => {
        await this.#ensureFresh(member, signal);
        const discovered = await this.#discoverMemberModels(member, signal);
        const normalized = discovered.map((model) =>
          typeof model === "string" ? { id: model } : model
        );
        member.models = new Set(normalized.map((model) => model.id));
        return normalized;
      })
    );
    // Promise.allSettled preserves input order. Merge after all discoveries
    // finish so conflicts resolve by configured account order, not timing.
    for (const discovery of discoveries) {
      if (discovery.status !== "fulfilled") continue;
      for (const model of discovery.value) {
        if (model.reasoning !== undefined && !this.#reasoning.has(model.id)) {
          this.#reasoning.set(model.id, model.reasoning);
        }
      }
    }
    // Models retained from a failed discovery keep the controls we last saw,
    // so a blip cannot silently downgrade them to no reasoning support.
    const served = new Set(this.listModelIds());
    for (const [model, capabilities] of previousReasoning) {
      if (served.has(model) && !this.#reasoning.has(model)) {
        this.#reasoning.set(model, capabilities);
      }
    }
    this.#catalogReady = true;
    return this.listModelIds();
  }

  listModelIds(): readonly string[] {
    const models = new Set<string>();
    for (const member of this.#members) {
      for (const model of member.models) models.add(model);
    }
    return [...models];
  }

  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.#reasoning.get(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#probeTimer !== undefined) {
      clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
    await Promise.allSettled([
      ...this.#refreshes.values(),
      ...(this.#usageProbe !== undefined ? [this.#usageProbe] : [])
    ]);
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await Promise.allSettled(
      this.#members.map(async (member) => {
        await this.#ensureFresh(member, signal);
        const cooldownRevision = member.cooldownRevision;
        const cooldownContext = this.#tracker.cooldownContext(member.id);
        const limits = await this.#provider.fetchUsage(member.credential, signal);
        const withResets = await this.#attachResetCredits(member, limits, signal);
        const recovered = this.#snapshotRecovered(withResets, cooldownContext);
        this.#tracker.reconcileSnapshot(member.id, withResets, cooldownRevision, recovered);
        member.coolingUntil = this.#tracker.coolingUntil(member.id);
        member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
      })
    );
  }

  /**
   * List banked rate-limit reset credits for one enrolled member.
   * Throws when the provider does not support resets or the label is missing.
   */
  async listResetCredits(label: string, signal?: AbortSignal): Promise<ResetCreditSnapshot> {
    const member = this.#requireMember(label);
    await this.#ensureFresh(member, signal);
    return await this.#fetchResetCredits(member, signal);
  }

  /**
   * Redeem one banked rate-limit reset for an enrolled member, then refresh
   * usage and clear local cooling so the pool can route again immediately.
   */
  async redeemResetCredit(
    input: RedeemResetCreditInput,
    signal?: AbortSignal
  ): Promise<RedeemResetCreditResult> {
    if (this.#provider.consumeResetCredit === undefined) {
      throw new Error(`${this.mode} does not support redeemable rate-limit resets`);
    }
    const member = this.#requireMember(input.label);
    await this.#ensureFresh(member, signal);
    const expectedCooldownRevision = this.#tracker.cooldownRevision(member.id);
    const redeemRequestId =
      input.redeemRequestId !== undefined && input.redeemRequestId.trim().length > 0
        ? input.redeemRequestId.trim()
        : randomUUID();
    let creditId = input.creditId?.trim();
    if (creditId !== undefined && creditId.length === 0) {
      throw new Error("creditId must not be empty");
    }
    if (creditId === undefined) {
      const listed = await this.#fetchResetCredits(member, signal);
      const available = (listed.credits ?? []).filter((credit) => {
        const status = credit.status?.toLowerCase();
        return status === undefined || status === "available" || status === "active";
      });
      if (available.length === 0 && listed.availableCount === 0) {
        throw new Error(`${this.mode}/${member.label} has no redeemable rate-limit resets`);
      }
      const pick = [...available].sort((left, right) => {
        const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY;
        const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY;
        return leftExpiry - rightExpiry;
      })[0];
      if (pick === undefined) {
        // Upstream reported a count but no detail rows — let consume auto-select.
        creditId = undefined;
      } else {
        creditId = pick.id;
      }
    }
    const result = await this.#provider.consumeResetCredit(
      member.credential,
      {
        redeemRequestId,
        ...(creditId !== undefined ? { creditId } : {})
      },
      signal
    );
    if (result.ok) {
      try {
        const limits = await this.#provider.fetchUsage(member.credential, signal);
        const withResets = await this.#attachResetCredits(member, limits, signal);
        this.#tracker.update(member.id, withResets);
      } catch {
        // Consume already succeeded; clear cooling even if refresh fails.
      }
      if (this.#tracker.clearCooling(member.id, expectedCooldownRevision)) {
        delete member.coolingUntil;
      } else {
        member.coolingUntil = this.#tracker.coolingUntil(member.id);
      }
      member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
    }
    return {
      ...result,
      label: member.label,
      mode: this.mode,
      ...(creditId !== undefined && result.creditId === undefined ? { creditId } : {})
    };
  }

  /**
   * Refresh stale or missing usage without allowing rapid callers to hammer
   * provider quota endpoints. Failed attempts are throttled as well.
   */
  async refreshUsage(maxAgeMs = 60_000, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new RangeError("usage refresh age must be a non-negative finite number");
    }
    if (this.#members.length === 0) return;
    const now = Date.now();
    const allFresh = this.#members.every((member) => {
      const limits = this.#tracker.limits(member.id);
      return limits?.completeness === "snapshot" && now - limits.observedAt * 1000 < maxAgeMs;
    });
    if (allFresh) return;
    if (this.#usageProbe !== undefined) return await this.#usageProbe;
    if (this.#lastUsageProbeAt !== undefined && now - this.#lastUsageProbeAt < maxAgeMs) {
      return;
    }
    this.#lastUsageProbeAt = now;
    const probe = this.probe(signal).finally(() => {
      if (this.#usageProbe === probe) this.#usageProbe = undefined;
    });
    this.#usageProbe = probe;
    await probe;
  }

  async execute(
    model: string | undefined,
    operation: (credential: SubscriptionCredential) => Promise<Response>,
    signal?: AbortSignal,
    observer?: SubscriptionExecutionObserver
  ): Promise<Response> {
    if (this.#members.length === 0) throw new SubscriptionAccountSetExhaustedError(this.mode);
    const excluded = new Set<string>();
    const absorbed = new Set<string>();
    const reauthenticated = new Set<string>();
    let transientFailovers = 0;

    while (excluded.size < this.#members.length) {
      const lease = await this.#acquire(model, excluded, signal);
      const member = lease.value;
      let handedOff = false;
      const releaseActivity = this.#activity.beginAttempt(
        subscriptionAccountIdentity(this.mode, member.label)
      );
      const release = this.#once(() => {
        releaseActivity();
        this.#release(member);
        lease.release();
      });
      try {
        observer?.onAttempt?.({ seat: attributionSeat(member.label) });
        let response: Response;
        try {
          response = await operation(member.credential);
        } catch (error) {
          throw error;
        }
        const headerLimits = this.#provider.parseLimits(response.headers);
        if (headerLimits !== undefined) this.#tracker.update(member.id, headerLimits);

        if (response.ok) {
          const inspected = await this.#inspectSuccessfulResponse(
            member,
            response,
            observer?.responseMode ?? "streaming",
            model,
            release,
            signal
          );
          if (inspected.failure === undefined) {
            handedOff = true;
            return inspected.response;
          }
          const failure = inspected.failure;
          const passthrough = inspected.response;
          if (!isRetryableProviderFailure(failure.category)) return passthrough;
          if (failure.category === "transient") {
            if (!absorbed.has(member.id)) {
              absorbed.add(member.id);
              const delaySeconds = Math.min(60, failure.retryAfter ?? 0.5);
              await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
              continue;
            }
            const now = Date.now() / 1000;
            const hasAlternative = this.#members.some(
              (candidate) =>
                candidate.id !== member.id &&
                !excluded.has(candidate.id) &&
                this.#eligible(candidate, model, now)
            );
            if (transientFailovers === 0 && hasAlternative) {
              transientFailovers += 1;
              excluded.add(member.id);
              continue;
            }
            return passthrough;
          }
          const until =
            failure.resetsAt ??
            Date.now() / 1000 + (failure.retryAfter ?? this.#options.fallbackCooldownSeconds);
          this.#penalize(member, until, model);
          excluded.add(member.id);
          continue;
        }

        const text = await response.text();
        const parsed = this.#parseJson(text);
        const bodyLimits = this.#provider.parseLimits(response.headers, parsed);
        if (bodyLimits !== undefined) this.#tracker.update(member.id, bodyLimits);
        const failure = this.#provider.classify(response.status, response.headers, parsed);
        const passthrough = new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
        if (
          (response.status === 401 || response.status === 403) &&
          !reauthenticated.has(member.id) &&
          (await this.#forceRefresh(member, signal))
        ) {
          reauthenticated.add(member.id);
          continue;
        }
        if (failure === undefined || !isRetryableProviderFailure(failure.category))
          return passthrough;

        if (failure.category === "transient") {
          if (!absorbed.has(member.id)) {
            absorbed.add(member.id);
            const delaySeconds = Math.min(60, failure.retryAfter ?? 0.5);
            await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
            continue;
          }
          const now = Date.now() / 1000;
          const hasAlternative = this.#members.some(
            (candidate) =>
              candidate.id !== member.id &&
              !excluded.has(candidate.id) &&
              this.#eligible(candidate, model, now)
          );
          if (transientFailovers === 0 && hasAlternative) {
            transientFailovers += 1;
            excluded.add(member.id);
            continue;
          }
          return passthrough;
        }

        const until =
          failure.resetsAt ??
          Date.now() / 1000 + (failure.retryAfter ?? this.#options.fallbackCooldownSeconds);
        this.#penalize(member, until, model);
        excluded.add(member.id);
      } finally {
        if (!handedOff) release();
      }
    }
    throw new SubscriptionAccountSetExhaustedError(this.mode, this.#soonestReset(model));
  }

  #memberStatus(member: PoolMember): SubscriptionMemberStatus {
    const activity = this.#activity.snapshot(subscriptionAccountIdentity(this.mode, member.label));
    return {
      id: member.id,
      mode: this.mode,
      label: member.label,
      sourcePath: member.sourcePath,
      ...(member.credential.expiresAt !== undefined
        ? { expiresAt: member.credential.expiresAt }
        : {}),
      ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
      ...activity,
      // Compatibility only: `active` now aliases durable last-selection.
      active: activity.lastSelected,
      models: [...member.models],
      ...(this.#tracker.limits(member.id) !== undefined
        ? { limits: this.#tracker.limits(member.id) }
        : {})
    };
  }

  #requireMember(label: string): PoolMember {
    const normalized = label.trim();
    if (normalized.length === 0) {
      throw new Error("account label is required");
    }
    const member = this.#members.find((candidate) => candidate.label === normalized);
    if (member === undefined) {
      throw new Error(`${this.mode}/${normalized} is not enrolled`);
    }
    return member;
  }

  async #fetchResetCredits(member: PoolMember, signal?: AbortSignal): Promise<ResetCreditSnapshot> {
    if (this.#provider.fetchResetCredits === undefined) {
      throw new Error(`${this.mode} does not support redeemable rate-limit resets`);
    }
    const resetCredits = await this.#provider.fetchResetCredits(member.credential, signal);
    const previous = this.#tracker.limits(member.id);
    this.#tracker.update(member.id, {
      ...(previous ?? {
        windows: {},
        source: "usage" as const,
        completeness: "partial" as const
      }),
      resetCredits,
      observedAt: previous?.observedAt ?? resetCredits.observedAt
    });
    return resetCredits;
  }

  async #attachResetCredits(
    member: PoolMember,
    limits: AccountLimits,
    signal?: AbortSignal
  ): Promise<AccountLimits> {
    if (this.#provider.fetchResetCredits === undefined) return limits;
    try {
      const resetCredits = await this.#provider.fetchResetCredits(member.credential, signal);
      return { ...limits, resetCredits };
    } catch {
      // Keep the last authoritative snapshot when the dedicated listing fails.
      // Do not let a weaker embedded usage payload erase known credit rows.
      const previous = this.#tracker.limits(member.id)?.resetCredits;
      return previous === undefined ? limits : { ...limits, resetCredits: previous };
    }
  }

  async #acquire(
    model: string | undefined,
    excluded: Set<string>,
    signal?: AbortSignal
  ): Promise<CapacityLease<PoolMember>> {
    const now = Date.now() / 1000;
    for (const member of this.#members) {
      if (member.coolingUntil !== undefined && member.coolingUntil <= now) {
        if (this.#tracker.clearCooling(member.id, member.cooldownRevision)) {
          delete member.coolingUntil;
          member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
        } else {
          member.coolingUntil = this.#tracker.coolingUntil(member.id);
          member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
        }
      }
    }
    const eligible = this.#members.filter(
      (member) => !excluded.has(member.id) && this.#eligible(member, model, now)
    );
    if (eligible.length === 0) {
      throw new SubscriptionAccountSetExhaustedError(this.mode, this.#soonestReset(model));
    }
    const ineligible = new Set([
      ...excluded,
      ...this.#members.filter((member) => !eligible.includes(member)).map((member) => member.id)
    ]);
    if (this.#capacityPool === undefined) {
      throw new SubscriptionAccountSetExhaustedError(this.mode);
    }
    for (const member of this.#members) {
      this.#capacityPool.update(member.id, {
        quotaUtilization: this.#quotaUtilization(member, model),
        ...(member.coolingUntil !== undefined
          ? { coolingUntil: member.coolingUntil * 1000 }
          : { coolingUntil: undefined })
      });
    }
    const lease = this.#capacityPool.acquire(model ?? "default", ineligible);
    const member = lease.value;
    try {
      await this.#ensureFresh(member, signal);
      if (this.#activeId !== member.id) {
        this.#activeId = member.id;
        member.switchedAt = Date.now();
      }
      await this.#waitForRamp(member, signal);
      await this.#options.beforeAcquisitionRevalidation?.({ label: member.label });
      const revalidatedAt = Date.now() / 1000;
      if (excluded.has(member.id) || !this.#eligible(member, model, revalidatedAt)) {
        lease.release();
        return await this.#acquire(model, excluded, signal);
      }
      member.inFlight += 1;
      member.lastUsed = Date.now();
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  #release(member: PoolMember): void {
    member.inFlight = Math.max(0, member.inFlight - 1);
  }

  #eligible(member: PoolMember, model: string | undefined, now: number): boolean {
    return isPoolEligible({
      limits: this.#tracker.limits(member.id),
      switchThreshold: this.#options.switchThreshold,
      ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
      ...(member.credential.expiresAt !== undefined
        ? { credentialExpiresAt: member.credential.expiresAt }
        : {}),
      hasRefreshToken: member.credential.refreshToken !== undefined,
      catalogReady: this.#catalogReady,
      models: [...member.models],
      ...(model !== undefined ? { model } : {}),
      now,
      isWindowRelevant: (key, limitName) => this.#windowRelevant(key, limitName, model)
    });
  }

  #headroom(member: PoolMember, model: string | undefined): number {
    return memberHeadroom(this.#tracker.limits(member.id), (key, limitName) =>
      this.#windowRelevant(key, limitName, model)
    );
  }

  #quotaUtilization(member: PoolMember, model: string | undefined): number {
    const utilization = 1 - this.#headroom(member, model);
    if (
      isOverSwitchThreshold(this.#headroom(member, model), this.#options.switchThreshold) &&
      hasUsableCredits(this.#tracker.limits(member.id)?.credits)
    ) {
      // Credits keep the member routable, but capacity selection should still
      // prefer members below the proactive switch threshold.
      return Math.min(utilization, this.#options.switchThreshold);
    }
    return utilization;
  }

  #windowRelevant(key: string, limitName: string | undefined, model: string | undefined): boolean {
    const lowered = (model ?? "").toLowerCase();
    const descriptor = `${key} ${limitName ?? ""}`.toLowerCase();
    for (const family of ["sonnet", "opus", "haiku", "spark"]) {
      if (descriptor.includes(family)) return lowered.includes(family);
    }
    return true;
  }

  #soonestReset(model: string | undefined): number | undefined {
    const now = Date.now() / 1000;
    const resets: number[] = [];
    for (const member of this.#members) {
      if (!this.#eligible(member, model, now)) {
        if (member.coolingUntil !== undefined && member.coolingUntil > now) {
          resets.push(member.coolingUntil);
        }
        const limits = this.#tracker.limits(member.id);
        if (limits === undefined) continue;
        for (const [key, window] of Object.entries(limits.windows)) {
          if (
            window.resetsAt !== undefined &&
            window.resetsAt > now &&
            this.#windowRelevant(key, window.limitName, model) &&
            isOverSwitchThreshold(
              memberHeadroom(limits, (candidateKey, limitName) =>
                this.#windowRelevant(candidateKey, limitName, model)
              ),
              this.#options.switchThreshold
            ) &&
            !hasUsableCredits(limits.credits)
          ) {
            resets.push(window.resetsAt);
          }
        }
      }
    }
    return resets.length > 0 ? Math.min(...resets) : undefined;
  }

  #penalize(member: PoolMember, until: number, model: string | undefined): void {
    member.coolingUntil = until;
    const limits = this.#tracker.limits(member.id);
    const windows =
      limits === undefined
        ? undefined
        : Object.entries(limits.windows)
            .filter(([key, window]) => this.#windowRelevant(key, window.limitName, model))
            .map(([key]) => key);
    member.cooldownRevision = this.#tracker.cool(member.id, until, {
      ...(model !== undefined ? { model } : {}),
      ...(windows !== undefined && windows.length > 0 ? { windows } : {})
    });
    if (this.#activeId === member.id) this.#activeId = undefined;
  }

  #snapshotRecovered(limits: AccountLimits, context: CooldownContext | undefined): boolean {
    if (limits.completeness !== "snapshot") return false;
    const relevant = (key: string, limitName?: string): boolean => {
      if (context?.windows !== undefined && context.windows.length > 0) {
        return context.windows.includes(key);
      }
      if (context?.model === undefined) return true;
      return this.#windowRelevant(key, limitName, context.model);
    };
    return (
      quotaAdmissionReasons({
        limits,
        switchThreshold: this.#options.switchThreshold,
        isWindowRelevant: relevant
      }).length === 0
    );
  }

  /**
   * A member keeps its previous catalog when discovery fails, because an empty
   * model set makes it pool-ineligible: a provider blip would otherwise take
   * every account dark until discovery succeeds again.
   */
  async #discoverMemberModels(
    member: PoolMember,
    signal?: AbortSignal
  ): Promise<readonly (string | DiscoveredModel)[]> {
    try {
      return await this.#provider.discoverModels(member.credential, signal);
    } catch (error) {
      if (!(await this.#forceRefresh(member, signal))) throw error;
      return await this.#provider.discoverModels(member.credential, signal);
    }
  }

  /**
   * Providers can stop honoring an access token long before the token's own
   * expiry claim lapses, which `#ensureFresh` cannot see. Spend one refresh,
   * rate limited per member, before blaming the account.
   */
  async #forceRefresh(member: PoolMember, signal?: AbortSignal): Promise<boolean> {
    if (member.credential.refreshToken === undefined) return false;
    const existing = this.#refreshes.get(member.id);
    if (existing !== undefined) {
      try {
        await existing;
        return true;
      } catch {
        return false;
      }
    }
    const now = Date.now();
    if (
      member.forcedRefreshAt !== undefined &&
      now - member.forcedRefreshAt < FORCED_REFRESH_COOLDOWN_MS
    ) {
      return false;
    }
    member.forcedRefreshAt = now;
    const expectedCooldownRevision = this.#tracker.cooldownRevision(member.id);
    const refresh = (async () => {
      member.credential = await this.#provider.refresh(member.credential, signal);
      if (this.#tracker.resetAfterRefresh(member.id, expectedCooldownRevision)) {
        delete member.coolingUntil;
      } else {
        member.coolingUntil = this.#tracker.coolingUntil(member.id);
      }
      member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
    })().finally(() => this.#refreshes.delete(member.id));
    this.#refreshes.set(member.id, refresh);
    try {
      await refresh;
      return true;
    } catch {
      return false;
    }
  }

  async #ensureFresh(member: PoolMember, signal?: AbortSignal): Promise<void> {
    const expiresAt = member.credential.expiresAt;
    if (
      expiresAt === undefined ||
      expiresAt - Date.now() / 1000 > this.#options.refreshSkewSeconds
    ) {
      return;
    }
    const existing = this.#refreshes.get(member.id);
    if (existing !== undefined) return existing;
    const expectedCooldownRevision = this.#tracker.cooldownRevision(member.id);
    const refresh = (async () => {
      member.credential = await this.#provider.refresh(member.credential, signal);
      if (this.#tracker.resetAfterRefresh(member.id, expectedCooldownRevision)) {
        delete member.coolingUntil;
      } else {
        member.coolingUntil = this.#tracker.coolingUntil(member.id);
      }
      member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
    })().finally(() => this.#refreshes.delete(member.id));
    this.#refreshes.set(member.id, refresh);
    return refresh;
  }

  async #waitForRamp(member: PoolMember, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const elapsed = Date.now() - member.switchedAt;
      if (elapsed >= RAMP_WINDOW_MS) return;
      const cap = 1 + Math.floor(elapsed / RAMP_STEP_MS);
      if (member.inFlight < cap) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, RAMP_STEP_MS);
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("account operation aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  #once(release: () => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  async #inspectSuccessfulResponse(
    member: PoolMember,
    response: Response,
    responseMode: BackendResponseMode,
    model: string | undefined,
    release: () => void,
    signal?: AbortSignal
  ): Promise<{ response: Response; failure?: SubscriptionFailure }> {
    if (
      response.body === null ||
      !response.headers.get("content-type")?.includes("text/event-stream") ||
      this.#provider.parseStreamOutcome === undefined
    ) {
      return { response: this.#trackResponseCompletion(response, release) };
    }
    if (responseMode === "buffered") {
      const bytes = await this.#readBoundedBody(response.body, release, signal);
      const outcome = this.#scanBufferedStream(member, bytes);
      const replay = new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      if (outcome.failure !== undefined) return { response: replay, failure: outcome.failure };
      release();
      return { response: replay };
    }
    return await this.#inspectStreamingPrelude(member, response, model, release, signal);
  }

  #scanBufferedStream(member: PoolMember, bytes: Uint8Array): { failure?: SubscriptionFailure } {
    const decoder = new SseDecoder();
    let failure: SubscriptionFailure | undefined;
    const events = [...decoder.feed(bytes), ...decoder.flush()];
    for (const event of events) {
      const raw = event.data.trim();
      if (raw.length === 0 || raw === "[DONE]") continue;
      const payload = JSON.parse(raw) as unknown;
      const limits = this.#provider.parseStreamEvent(payload);
      if (limits !== undefined) this.#tracker.update(member.id, limits);
      const outcome = this.#provider.parseStreamOutcome?.(event.event, payload);
      if (outcome?.failure !== undefined) failure = outcome.failure;
    }
    return failure === undefined ? {} : { failure };
  }

  async #inspectStreamingPrelude(
    member: PoolMember,
    response: Response,
    model: string | undefined,
    release: () => void,
    signal?: AbortSignal
  ): Promise<{ response: Response; failure?: SubscriptionFailure }> {
    const reader = response.body!.getReader();
    const decoder = new SseDecoder();
    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let terminalFailure: SubscriptionFailure | undefined;
    let terminalFailureApplied = false;
    let semanticOutput = false;
    const inspect = (chunk: Uint8Array): void => {
      for (const event of decoder.feed(chunk)) {
        const raw = event.data.trim();
        if (raw.length === 0 || raw === "[DONE]") continue;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        const limits = this.#provider.parseStreamEvent(payload);
        if (limits !== undefined) this.#tracker.update(member.id, limits);
        const outcome = this.#provider.parseStreamOutcome?.(event.event, payload);
        if (outcome?.semanticOutput === true) semanticOutput = true;
        if (outcome?.failure !== undefined) terminalFailure = outcome.failure;
      }
    };
    const applyTerminalFailure = (): void => {
      if (
        terminalFailureApplied ||
        terminalFailure === undefined ||
        !isRetryableProviderFailure(terminalFailure.category)
      )
        return;
      terminalFailureApplied = true;
      const until =
        terminalFailure.resetsAt ??
        Date.now() / 1000 + (terminalFailure.retryAfter ?? this.#options.fallbackCooldownSeconds);
      this.#penalize(member, until, model);
    };
    while (!semanticOutput && terminalFailure === undefined) {
      const next = await this.#readWithAbort(reader, signal);
      if (next.done) {
        try {
          decoder.flush();
        } finally {
          release();
        }
        break;
      }
      buffered.push(next.value);
      bufferedBytes += next.value.byteLength;
      // Retry buffering is deliberately bounded: a provider that emits over
      // 1 MiB before semantic output/terminal state fails deterministically.
      if (bufferedBytes > SUBSCRIPTION_SSE_BUFFER_CAP_BYTES) {
        await reader.cancel("RouteKit SSE prelude exceeded 1 MiB");
        release();
        throw new SseParseError("provider SSE prelude exceeded the 1 MiB retry buffer cap");
      }
      inspect(next.value);
    }
    if (terminalFailure !== undefined && semanticOutput) applyTerminalFailure();
    if (terminalFailure !== undefined && !semanticOutput) {
      await reader.cancel();
      release();
      return {
        response: new Response(this.#concatBytes(buffered), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        }),
        failure: terminalFailure
      };
    }
    const pool = this;
    let prefix = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (prefix < buffered.length) {
            controller.enqueue(buffered[prefix++]!);
            return;
          }
          const next = await pool.#readWithAbort(reader, signal);
          if (next.done) {
            try {
              decoder.flush();
            } finally {
              release();
            }
            controller.close();
            return;
          }
          inspect(next.value);
          if (terminalFailure !== undefined) applyTerminalFailure();
          controller.enqueue(next.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      }
    });
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    };
  }

  async #readBoundedBody(
    body: ReadableStream<Uint8Array>,
    release: () => void,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await this.#readWithAbort(reader, signal);
        if (next.done) return this.#concatBytes(chunks);
        size += next.value.byteLength;
        if (size > SUBSCRIPTION_SSE_BUFFER_CAP_BYTES) {
          throw new SseParseError(
            `provider SSE body exceeded the ${SUBSCRIPTION_SSE_BUFFER_CAP_BYTES}-byte buffer cap`
          );
        }
        chunks.push(next.value);
      }
    } catch (error) {
      try {
        if (signal?.aborted !== true) await reader.cancel(error);
      } catch {
        /* Preserve the primary error. */
      }
      throw error;
    } finally {
      release();
    }
  }

  async #readWithAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal
  ): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
    if (signal === undefined) return await reader.read();
    if (signal.aborted) {
      await reader.cancel(signal.reason);
      throw signal.reason ?? new Error("account operation aborted");
    }
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(signal.reason ?? new Error("account operation aborted"));
        void reader.cancel(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), aborted]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  #concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  #trackResponseCompletion(response: Response, release: () => void): Response {
    if (response.body === null) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            release();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      }
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  #parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  #startProbe(): void {
    const interval = this.#options.probeIntervalMs ?? 0;
    if (interval <= 0) return;
    this.#probeTimer = setInterval(
      () => {
        void this.refreshUsage(0);
      },
      Math.max(60_000, interval)
    );
    this.#probeTimer.unref();
    void this.refreshUsage(0);
  }
}
