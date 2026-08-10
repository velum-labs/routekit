import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  isRetryableProviderFailure,
  type ModelCapabilityMetadata,
  type ModelReasoningCapabilities,
  type ModelSelectionSignals,
  ProviderFailureError
} from "@velum-labs/routekit-contracts";
import type {
  BackendResponseMode,
  CapacityLease,
  DiscoveredModel
} from "@velum-labs/routekit-gateway";
import { CapacityPool, SseDecoder, SseParseError } from "@velum-labs/routekit-gateway";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";

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
import type { AuthRecoveryClaim } from "./auth-health.js";
import { AccountAuthCoordinator } from "./auth-health.js";
import { subscriptionCredentialFingerprint, subscriptionCredentialLabel } from "./credentials.js";
import type { ConsumeResetCreditResult } from "./provider.js";
import {
  type SubscriptionProvider,
  SubscriptionProviderRequestError,
  SubscriptionRefreshError
} from "./provider.js";
import { RateLimitTracker } from "./rate-limit-tracker.js";
import type { CooldownContext } from "./rate-limit-tracker.js";
import type {
  AccountLimits,
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
  authHealth?: AccountAuthCoordinator;
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
  credentialFingerprint: string;
};

type ProbationAttempt = {
  member: PoolMember;
  claim: AuthRecoveryClaim;
};

const DEFAULT_SWITCH_THRESHOLD = 0.9;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 300;
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

export class SubscriptionAccountSetAuthError extends ProviderFailureError {
  constructor(mode: SubscriptionMode) {
    super({
      category: "auth_permanent",
      status: 401,
      message:
        `all ${mode} subscription pool members were rejected by upstream authentication; ` +
        `run \`routekit accounts status\`, then remove and re-login each rejected ${mode} account`
    });
  }
}

export class SubscriptionAccountSetAuthRecoveryError extends ProviderFailureError {
  constructor(mode: SubscriptionMode, retryAt: number) {
    super({
      category: "auth_transient",
      message: `all ${mode} subscription pool members are waiting for authentication recovery`,
      retryAfter: Math.max(0, retryAt - Date.now() / 1000)
    });
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
  readonly #metadata = new Map<string, ModelCapabilityMetadata>();
  readonly #selectionSignals = new Map<string, ModelSelectionSignals>();
  readonly #authHealth: AccountAuthCoordinator;
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
    this.#authHealth = options.authHealth ?? new AccountAuthCoordinator();
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
        const credentialFingerprint = subscriptionCredentialFingerprint(sourcePath);
        (options.authHealth ??= new AccountAuthCoordinator()).register(
          subscriptionAccountIdentity(options.mode, id),
          credentialFingerprint
        );
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
          switchedAt: 0,
          credentialFingerprint
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
        const auth = this.#authHealth.snapshot(
          subscriptionAccountIdentity(this.mode, member.label),
          member.credentialFingerprint
        );
        const upstreamAuthState = auth.kind === "superseded" ? "unknown" : auth.kind;
        const readinessReasons = credentialValid
          ? [
              ...(auth.kind === "refreshing"
                ? [{ code: "provider_auth_refreshing" as const }]
                : auth.kind === "backoff" && auth.retryAt !== undefined
                  ? [{ code: "provider_auth_backoff" as const, until: auth.retryAt / 1000 }]
                  : auth.kind === "rejected"
                    ? [
                        {
                          code: "provider_auth_rejected" as const,
                          status: auth.status ?? 401
                        }
                      ]
                    : []),
              ...readiness.reasons
            ]
          : member.credential.expiresAt !== undefined && member.credential.expiresAt <= now
            ? readiness.reasons
            : [{ code: "credential_invalid" as const }, ...readiness.reasons];
        const poolEligible =
          readiness.eligible &&
          (auth.kind === "unknown" ||
            auth.kind === "accepted" ||
            (auth.kind === "backoff" && (auth.retryAt ?? Number.POSITIVE_INFINITY) <= Date.now()));
        return {
          ...status,
          credentialValid,
          upstreamAuthState,
          poolEligible,
          relayReady: credentialValid && poolEligible,
          readinessReasons
        };
      })
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly string[]> {
    const previousMetadata = new Map(this.#metadata);
    const previousSelectionSignals = new Map(this.#selectionSignals);
    const previousReasoning = new Map(this.#reasoning);
    this.#metadata.clear();
    this.#selectionSignals.clear();
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
        if (model.metadata !== undefined && !this.#metadata.has(model.id)) {
          this.#metadata.set(model.id, model.metadata);
        }
        if (model.createdAt !== undefined || model.providerPriority !== undefined) {
          const existing = this.#selectionSignals.get(model.id);
          this.#selectionSignals.set(model.id, {
            ...(existing?.createdAt !== undefined
              ? { createdAt: existing.createdAt }
              : model.createdAt !== undefined
                ? { createdAt: model.createdAt }
                : {}),
            ...(existing?.providerPriority !== undefined
              ? { providerPriority: existing.providerPriority }
              : model.providerPriority !== undefined
                ? { providerPriority: model.providerPriority }
                : {})
          });
        }
        if (model.reasoning !== undefined && !this.#reasoning.has(model.id)) {
          this.#reasoning.set(model.id, model.reasoning);
        }
      }
    }
    // Models retained from a failed discovery keep the controls we last saw,
    // so a blip cannot silently downgrade them to no reasoning support.
    const served = new Set(this.listModelIds());
    for (const [model, metadata] of previousMetadata) {
      if (served.has(model) && !this.#metadata.has(model)) {
        this.#metadata.set(model, metadata);
      }
    }
    for (const [model, signals] of previousSelectionSignals) {
      if (served.has(model) && !this.#selectionSignals.has(model)) {
        this.#selectionSignals.set(model, signals);
      }
    }
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

  modelMetadata(model: string): ModelCapabilityMetadata | undefined {
    return this.#metadata.get(model);
  }

  modelSelectionSignals(model: string): ModelSelectionSignals | undefined {
    return this.#selectionSignals.get(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#probeTimer !== undefined) {
      clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
    if (this.#usageProbe !== undefined) await Promise.allSettled([this.#usageProbe]);
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const results = await Promise.allSettled(
      this.#members.map(async (member) => {
        await this.#ensureFresh(member, signal);
        const cooldownRevision = member.cooldownRevision;
        const cooldownContext = this.#tracker.cooldownContext(member.id);
        const limits = await this.#fetchUsageWithAuthRecovery(member, signal);
        const withResets = await this.#attachResetCredits(member, limits, signal);
        const recovered = this.#snapshotRecovered(withResets, cooldownContext);
        this.#tracker.reconcileSnapshot(member.id, withResets, cooldownRevision, recovered);
        member.coolingUntil = this.#tracker.coolingUntil(member.id);
        member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
      })
    );
    if (results.every((result) => result.status === "fulfilled")) {
      this.#tracker.markRefreshCompleted();
    }
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
        const limits = await this.#fetchUsageWithAuthRecovery(member, signal);
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
    const requiresRefresh = this.#tracker.requiresRefresh();
    const allFresh = this.#members.every((member) => {
      const limits = this.#tracker.limits(member.id);
      return limits?.completeness === "snapshot" && now - limits.observedAt * 1000 < maxAgeMs;
    });
    if (!requiresRefresh && allFresh) return;
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
    let transientFailovers = 0;
    let probation: ProbationAttempt | undefined;

    while (excluded.size < this.#members.length) {
      const probationAttempt = probation;
      probation = undefined;
      if (probationAttempt === undefined) {
        const expiredBackoff = this.#members.find((member) => {
          if (
            excluded.has(member.id) ||
            (model !== undefined && this.#catalogReady && !member.models.has(model))
          ) {
            return false;
          }
          const auth = this.#authHealth.snapshot(
            subscriptionAccountIdentity(this.mode, member.label),
            member.credentialFingerprint
          );
          return (
            auth.kind === "backoff" && (auth.retryAt ?? Number.POSITIVE_INFINITY) <= Date.now()
          );
        });
        if (expiredBackoff !== undefined) {
          const claim = await this.#recoverAuthentication(
            expiredBackoff,
            expiredBackoff.credentialFingerprint,
            model,
            excluded,
            signal
          );
          if (claim !== undefined) {
            probation = { member: expiredBackoff, claim };
            continue;
          }
        }
      }
      const lease =
        probationAttempt === undefined
          ? await this.#acquire(model, excluded, signal)
          : await this.#acquireProbation(probationAttempt.member, signal);
      const member = lease.value;
      const attemptedFingerprint = member.credentialFingerprint;
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
            if (probationAttempt !== undefined) {
              this.#authHealth.finishProbation(probationAttempt.claim, { kind: "accepted" });
            } else {
              this.#authHealth.markAccepted(
                subscriptionAccountIdentity(this.mode, member.label),
                attemptedFingerprint
              );
            }
            handedOff = true;
            return inspected.response;
          }
          const failure = inspected.failure;
          const passthrough = inspected.response;
          if (probationAttempt !== undefined) {
            this.#finishProbationForFailure(probationAttempt.claim, failure);
          }
          if (failure.scope === "credential") {
            release();
            if (probationAttempt !== undefined) {
              excluded.add(member.id);
              continue;
            }
            const claim = await this.#recoverAuthentication(
              member,
              attemptedFingerprint,
              model,
              excluded,
              signal
            );
            if (claim !== undefined) probation = { member, claim };
            continue;
          }
          if (failure.scope === "member_model") {
            if (model !== undefined) member.models.delete(model);
            excluded.add(member.id);
            continue;
          }
          if (failure.scope === "request") return passthrough;
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
        if (probationAttempt !== undefined) {
          if (failure === undefined) {
            this.#authHealth.finishProbation(probationAttempt.claim, {
              kind: response.status >= 500 ? "inconclusive" : "accepted"
            });
          } else {
            this.#finishProbationForFailure(probationAttempt.claim, failure);
          }
        }
        if (failure?.scope === "credential") {
          release();
          if (probationAttempt !== undefined) {
            excluded.add(member.id);
            continue;
          }
          const claim = await this.#recoverAuthentication(
            member,
            attemptedFingerprint,
            model,
            excluded,
            signal
          );
          if (claim !== undefined) probation = { member, claim };
          continue;
        }
        if (failure?.scope === "member_model") {
          if (model !== undefined) member.models.delete(model);
          excluded.add(member.id);
          continue;
        }
        if (failure?.scope === "request") return passthrough;
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
    throw this.#unavailableError(model);
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
    await Promise.all(
      this.#members.flatMap((member) => {
        const synchronization = this.#synchronizeCredential(member);
        return synchronization === undefined ? [] : [synchronization];
      })
    );
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
      const activeRecovery = this.#members
        .filter(
          (member) =>
            !excluded.has(member.id) &&
            (model === undefined || !this.#catalogReady || member.models.has(model))
        )
        .map((member) =>
          this.#authHealth.completion(
            subscriptionAccountIdentity(this.mode, member.label),
            member.credentialFingerprint
          )
        )
        .find((completion) => completion !== undefined);
      if (activeRecovery !== undefined) {
        await this.#awaitAbortably(activeRecovery, signal);
        return await this.#acquire(model, excluded, signal);
      }
      throw this.#unavailableError(model);
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
      const retryAt = Date.now() / 1000;
      if (
        !excluded.has(member.id) &&
        !this.#eligible(member, model, retryAt) &&
        this.#members.some(
          (candidate) =>
            candidate.id !== member.id &&
            !excluded.has(candidate.id) &&
            this.#eligible(candidate, model, retryAt)
        )
      ) {
        excluded.add(member.id);
        return await this.#acquire(model, excluded, signal);
      }
      throw error;
    }
  }

  #release(member: PoolMember): void {
    member.inFlight = Math.max(0, member.inFlight - 1);
  }

  #eligible(member: PoolMember, model: string | undefined, now: number): boolean {
    const auth = this.#authHealth.snapshot(
      subscriptionAccountIdentity(this.mode, member.label),
      member.credentialFingerprint
    );
    if (auth.kind === "superseded" || auth.kind === "refreshing" || auth.kind === "rejected") {
      return false;
    }
    if (auth.kind === "backoff") return false;
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

  #unavailableError(model: string | undefined): ProviderFailureError {
    const relevant = this.#members.filter(
      (member) => model === undefined || !this.#catalogReady || member.models.has(model)
    );
    const auth = relevant.map((member) =>
      this.#authHealth.snapshot(
        subscriptionAccountIdentity(this.mode, member.label),
        member.credentialFingerprint
      )
    );
    const backoffs = auth.flatMap((snapshot) =>
      snapshot.kind === "backoff" && snapshot.retryAt !== undefined ? [snapshot.retryAt] : []
    );
    const authRetryAt = backoffs.length === 0 ? undefined : Math.min(...backoffs) / 1000;
    const quotaResetAt = this.#soonestReset(model);
    if (authRetryAt !== undefined && (quotaResetAt === undefined || authRetryAt < quotaResetAt)) {
      return new SubscriptionAccountSetAuthRecoveryError(this.mode, authRetryAt);
    }
    if (relevant.length > 0 && auth.every((snapshot) => snapshot.kind === "rejected")) {
      return new SubscriptionAccountSetAuthError(this.mode);
    }
    return new SubscriptionAccountSetExhaustedError(this.mode, quotaResetAt);
  }

  async #acquireProbation(
    member: PoolMember,
    signal?: AbortSignal
  ): Promise<CapacityLease<PoolMember>> {
    signal?.throwIfAborted();
    if (this.#capacityPool === undefined) {
      throw new SubscriptionAccountSetExhaustedError(this.mode);
    }
    const excluded = new Set(
      this.#members
        .filter((candidate) => candidate.id !== member.id)
        .map((candidate) => candidate.id)
    );
    const lease = this.#capacityPool.acquire("auth-probation", excluded);
    member.inFlight += 1;
    member.lastUsed = Date.now();
    return lease;
  }

  #synchronizeCredential(member: PoolMember): Promise<void> | undefined {
    const identity = subscriptionAccountIdentity(this.mode, member.label);
    const snapshot = this.#authHealth.snapshot(identity, member.credentialFingerprint);
    if (snapshot.kind !== "superseded") return;
    return (async () => {
      const fingerprint = subscriptionCredentialFingerprint(member.sourcePath);
      if (fingerprint !== snapshot.currentFingerprint) return;
      member.credential = await this.#provider.loadCredential(member.sourcePath);
      member.credentialFingerprint = fingerprint;
      this.#authHealth.register(identity, fingerprint);
    })();
  }

  async #recoverAuthentication(
    member: PoolMember,
    fingerprint: string,
    model: string | undefined,
    excluded: Set<string>,
    signal?: AbortSignal
  ): Promise<AuthRecoveryClaim | undefined> {
    const identity = subscriptionAccountIdentity(this.mode, member.label);
    const recovery = this.#authHealth.beginRecovery(identity, fingerprint);
    if (recovery.role === "superseded") {
      await this.#synchronizeCredential(member);
      return undefined;
    }
    if (recovery.role === "blocked") {
      excluded.add(member.id);
      return undefined;
    }
    if (recovery.role === "waiter") {
      const now = Date.now() / 1000;
      const hasAlternative = this.#members.some(
        (candidate) =>
          candidate.id !== member.id &&
          !excluded.has(candidate.id) &&
          this.#eligible(candidate, model, now)
      );
      if (hasAlternative) {
        excluded.add(member.id);
        return undefined;
      }
      const outcome = await this.#awaitAbortably(recovery.completion, signal);
      if (outcome.kind === "backoff" || outcome.kind === "rejected") excluded.add(member.id);
      return undefined;
    }

    try {
      const refreshSignal = AbortSignal.any([this.#authHealth.signal, AbortSignal.timeout(30_000)]);
      const expectedCooldownRevision = this.#tracker.cooldownRevision(member.id);
      const credential = await this.#provider.refresh(member.credential, refreshSignal);
      const refreshedFingerprint = subscriptionCredentialFingerprint(member.sourcePath);
      if (!this.#authHealth.markRefreshed(recovery.claim, refreshedFingerprint)) {
        await this.#synchronizeCredential(member);
        return undefined;
      }
      member.credential = credential;
      member.credentialFingerprint = refreshedFingerprint;
      if (this.#tracker.resetAfterRefresh(member.id, expectedCooldownRevision)) {
        delete member.coolingUntil;
      } else {
        member.coolingUntil = this.#tracker.coolingUntil(member.id);
      }
      member.cooldownRevision = this.#tracker.cooldownRevision(member.id);
      if (signal?.aborted === true) {
        this.#authHealth.finishProbation(recovery.claim, { kind: "inconclusive" });
        signal.throwIfAborted();
      }
      return recovery.claim;
    } catch (error) {
      if (error instanceof SubscriptionRefreshError) {
        this.#authHealth.failRefresh(recovery.claim, error.failure);
      } else {
        this.#authHealth.failRefresh(recovery.claim, {
          kind: "transient",
          failureKind: "network"
        });
      }
      if (signal?.aborted === true) signal.throwIfAborted();
      excluded.add(member.id);
      return undefined;
    }
  }

  #finishProbationForFailure(claim: AuthRecoveryClaim, failure: SubscriptionFailure): void {
    if (failure.scope === "credential" && (failure.status === 401 || failure.status === 403)) {
      this.#authHealth.finishProbation(claim, {
        kind: "rejected",
        status: failure.status,
        reasonCode: this.#authReasonCode(failure)
      });
      return;
    }
    if (
      failure.category === "quota_exhausted" ||
      failure.scope === "member_model" ||
      failure.scope === "request"
    ) {
      this.#authHealth.finishProbation(claim, { kind: "accepted" });
      return;
    }
    this.#authHealth.finishProbation(claim, { kind: "inconclusive" });
  }

  async #awaitAbortably<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return await promise;
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(signal.reason ?? new Error("account operation aborted"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      );
    });
  }

  #authReasonCode(failure: SubscriptionFailure): string {
    const identifier = (failure.code ?? failure.type)?.toLowerCase();
    switch (identifier) {
      case "authentication_error":
      case "invalid_token":
      case "invalidated_token":
      case "oauth_token_invalid":
      case "token_revoked":
      case "revoked_token":
      case "unauthorized":
        return identifier;
      default:
        return "upstream_auth_rejected";
    }
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
      const discovered = await this.#provider.discoverModels(member.credential, signal);
      this.#authHealth.markAccepted(
        subscriptionAccountIdentity(this.mode, member.label),
        member.credentialFingerprint
      );
      return discovered;
    } catch (error) {
      if (
        !(error instanceof SubscriptionProviderRequestError) ||
        error.failure.scope !== "credential"
      ) {
        throw error;
      }
      const claim = await this.#recoverAuthentication(
        member,
        member.credentialFingerprint,
        undefined,
        new Set(),
        signal
      );
      if (claim === undefined) throw error;
      try {
        const discovered = await this.#provider.discoverModels(member.credential, signal);
        this.#authHealth.finishProbation(claim, { kind: "accepted" });
        return discovered;
      } catch (retryError) {
        if (
          retryError instanceof SubscriptionProviderRequestError &&
          retryError.failure.scope === "credential" &&
          (retryError.failure.status === 401 || retryError.failure.status === 403)
        ) {
          this.#authHealth.finishProbation(claim, {
            kind: "rejected",
            status: retryError.failure.status,
            reasonCode: this.#authReasonCode(retryError.failure)
          });
        } else {
          this.#authHealth.finishProbation(claim, { kind: "inconclusive" });
        }
        throw retryError;
      }
    }
  }

  async #fetchUsageWithAuthRecovery(
    member: PoolMember,
    signal?: AbortSignal
  ): Promise<AccountLimits> {
    try {
      const limits = await this.#provider.fetchUsage(member.credential, signal);
      this.#authHealth.markAccepted(
        subscriptionAccountIdentity(this.mode, member.label),
        member.credentialFingerprint
      );
      return limits;
    } catch (error) {
      if (
        !(error instanceof SubscriptionProviderRequestError) ||
        error.failure.scope !== "credential"
      ) {
        throw error;
      }
      const claim = await this.#recoverAuthentication(
        member,
        member.credentialFingerprint,
        undefined,
        new Set(),
        signal
      );
      if (claim === undefined) throw error;
      try {
        const limits = await this.#provider.fetchUsage(member.credential, signal);
        this.#authHealth.finishProbation(claim, { kind: "accepted" });
        return limits;
      } catch (retryError) {
        if (
          retryError instanceof SubscriptionProviderRequestError &&
          retryError.failure.scope === "credential" &&
          (retryError.failure.status === 401 || retryError.failure.status === 403)
        ) {
          this.#authHealth.finishProbation(claim, {
            kind: "rejected",
            status: retryError.failure.status,
            reasonCode: this.#authReasonCode(retryError.failure)
          });
        } else {
          this.#authHealth.finishProbation(claim, { kind: "inconclusive" });
        }
        throw retryError;
      }
    }
  }

  async #ensureFresh(member: PoolMember, signal?: AbortSignal): Promise<void> {
    const synchronization = this.#synchronizeCredential(member);
    if (synchronization !== undefined) await synchronization;
    const expiresAt = member.credential.expiresAt;
    if (
      expiresAt === undefined ||
      expiresAt - Date.now() / 1000 > this.#options.refreshSkewSeconds
    ) {
      return;
    }
    const excluded = new Set<string>();
    const claim = await this.#recoverAuthentication(
      member,
      member.credentialFingerprint,
      undefined,
      excluded,
      signal
    );
    if (claim !== undefined) {
      this.#authHealth.finishProbation(claim, { kind: "inconclusive" });
      return;
    }
    const state = this.#authHealth.snapshot(
      subscriptionAccountIdentity(this.mode, member.label),
      member.credentialFingerprint
    );
    if (state.kind === "accepted" || state.kind === "unknown") return;
    throw this.#unavailableError(undefined);
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
      if (terminalFailureApplied || terminalFailure === undefined) return;
      terminalFailureApplied = true;
      if (terminalFailure.scope === "credential") {
        const fingerprint = member.credentialFingerprint;
        void this.#recoverAuthentication(member, fingerprint, model, new Set())
          .then((claim) => {
            if (claim !== undefined) {
              this.#authHealth.finishProbation(claim, { kind: "inconclusive" });
            }
          })
          .catch(() => undefined);
        return;
      }
      if (!isRetryableProviderFailure(terminalFailure.category)) return;
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
    if (interval <= 0) {
      if (this.#tracker.requiresRefresh()) void this.refreshUsage(0);
      return;
    }
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
