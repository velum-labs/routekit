import { join } from "node:path";
import type {
  ModelCapabilityMetadata,
  ModelReasoningCapabilities,
  ModelSelectionSignals
} from "@velum-labs/routekit-contracts";
import type { DiscoveredProviderModel } from "@velum-labs/routekit-contracts/provider-discovery";
import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { ResourceScope } from "@velum-labs/routekit-runtime";
import { AccountCatalogService } from "./account-set/catalog-service.js";
import { ResetCreditService } from "./account-set/reset-credits.js";
import { AccountSetStatusService } from "./account-set/status-service.js";
import { resolveSubscriptionAccounts } from "./account-source.js";
import { AccountActivityCoordinator, subscriptionAccountIdentity } from "./activity.js";
import { poolReadiness, quotaAdmissionReasons } from "./admission.js";
import type { AuthRecoveryClaim } from "./auth-health.js";
import { AccountAuthCoordinator } from "./auth-health.js";
import { subscriptionCredentialFingerprint, subscriptionCredentialLabel } from "./credentials.js";
import {
  type SubscriptionProvider,
  SubscriptionProviderRequestError,
  SubscriptionRefreshError
} from "./provider.js";
import type { CooldownContext } from "./rate-limit-tracker.js";
import { RateLimitTracker } from "./rate-limit-tracker.js";
import {
  SubscriptionAccountSetAuthError,
  SubscriptionAccountSetAuthRecoveryError,
  SubscriptionAccountSetExhaustedError,
  type SubscriptionPoolMember,
  SubscriptionPoolSelector
} from "./subscription-pool-selection.js";
import {
  type SubscriptionExecutionObserver,
  SubscriptionRequestExecutor
} from "./subscription-request-executor.js";
import { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES } from "./subscription-stream.js";

export {
  SubscriptionAccountSetAuthError,
  SubscriptionAccountSetAuthRecoveryError,
  SubscriptionAccountSetExhaustedError
} from "./subscription-pool-selection.js";
export type { SubscriptionExecutionObserver } from "./subscription-request-executor.js";

export { SUBSCRIPTION_SSE_BUFFER_CAP_BYTES } from "./subscription-stream.js";

import type {
  AccountLimits,
  ResetCreditSnapshot,
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionFailure,
  SubscriptionSelectionStrategy
} from "./types.js";

export type {
  CoordinatorResource,
  RedeemResetCreditInput,
  RedeemResetCreditResult,
  SubscriptionAccountSetOptions
} from "./account-set/types.js";

import type {
  CoordinatorResource,
  RedeemResetCreditInput,
  RedeemResetCreditResult,
  SubscriptionAccountSetOptions
} from "./account-set/types.js";

type PoolMember = SubscriptionPoolMember;

const DEFAULT_SWITCH_THRESHOLD = 0.9;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 300;
const RAMP_WINDOW_MS = 30_000;
const RAMP_STEP_MS = 250;
export class SubscriptionAccountSet<M extends SubscriptionMode = SubscriptionMode> {
  readonly #provider: SubscriptionProvider<M>;
  readonly #options: Required<
    Pick<
      SubscriptionAccountSetOptions,
      "strategy" | "switchThreshold" | "refreshSkewSeconds" | "fallbackCooldownSeconds"
    >
  > &
    SubscriptionAccountSetOptions;
  readonly #members: PoolMember[];
  readonly #selector: SubscriptionPoolSelector;
  readonly #executor: SubscriptionRequestExecutor;
  readonly #tracker: RateLimitTracker;
  readonly #activity: AccountActivityCoordinator;
  readonly #metadata = new Map<string, ModelCapabilityMetadata>();
  readonly #selectionSignals = new Map<string, ModelSelectionSignals>();
  readonly #authHealth: AccountAuthCoordinator;
  readonly #resources = new ResourceScope();
  readonly #reasoning = new Map<string, ModelReasoningCapabilities>();
  readonly #resetCredits: ResetCreditService<M>;
  readonly #catalog: AccountCatalogService<M>;
  readonly #status: AccountSetStatusService<M>;
  #usageProbe: Promise<void> | undefined;
  #lastUsageProbeAt: number | undefined;
  #catalogReady = false;
  #probeTimer: NodeJS.Timeout | undefined;
  #closed = false;

  private constructor(
    provider: SubscriptionProvider<M>,
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
    this.#tracker = tracker;
    this.#resetCredits = new ResetCreditService(provider, tracker);
    this.#catalog = new AccountCatalogService(
      members,
      this.#metadata,
      this.#selectionSignals,
      this.#reasoning,
      (member, signal) => this.#ensureFresh(member, signal),
      (member, signal) => this.#discoverMemberModels(member, signal),
      () => {
        this.#catalogReady = true;
      }
    );
    this.#activity = options.activity!.resource;
    this.#authHealth = options.authHealth!.resource;
    this.#selector = new SubscriptionPoolSelector({
      mode: provider.mode,
      members,
      tracker,
      authHealth: this.#authHealth,
      strategy: this.#options.strategy,
      switchThreshold: this.#options.switchThreshold,
      ...(this.#options.beforeAcquisitionRevalidation !== undefined
        ? { beforeAcquisitionRevalidation: this.#options.beforeAcquisitionRevalidation }
        : {}),
      synchronizeCredential: (member) => this.#synchronizeCredential(member),
      ensureFresh: async (member, signal) => await this.#ensureFresh(member, signal),
      waitForRamp: async (member, signal) => await this.#waitForRamp(member, signal)
    });
    this.#status = new AccountSetStatusService(
      provider.mode,
      this.#options.strategy,
      this.#options.switchThreshold,
      members,
      tracker,
      this.#activity,
      this.#authHealth,
      this.#selector,
      () => this.#catalogReady
    );

    this.#executor = new SubscriptionRequestExecutor({
      mode: provider.mode,
      members,
      provider,
      tracker,
      activity: this.#activity,
      authHealth: this.#authHealth,
      selector: this.#selector,
      fallbackCooldownSeconds: this.#options.fallbackCooldownSeconds,
      catalogReady: () => this.#catalogReady,
      recoverAuthentication: async (member, fingerprint, model, excluded, signal) =>
        await this.#recoverAuthentication(member, fingerprint, model, excluded, signal),
      finishProbationForFailure: (claim, failure) => this.#finishProbationForFailure(claim, failure)
    });
  }

  static async open<M extends SubscriptionMode>(
    provider: SubscriptionProvider<M>,
    options: SubscriptionAccountSetOptions
  ): Promise<SubscriptionAccountSet<M>> {
    const resources = new ResourceScope();
    try {
      const source = options.source ?? { kind: "auto" as const };
      const accounts = await resolveSubscriptionAccounts(provider.mode, source);
      const tracker = new RateLimitTracker(
        join(accounts.stateDirectory, ".state.json"),
        provider.mode
      );
      const activity =
        options.activity === undefined
          ? resources.own(new AccountActivityCoordinator())
          : options.activity.ownership === "owned"
            ? resources.own(options.activity.resource)
            : resources.borrow(options.activity.resource);
      const authHealth =
        options.authHealth === undefined
          ? resources.own(new AccountAuthCoordinator())
          : options.authHealth.ownership === "owned"
            ? resources.own(options.authHealth.resource)
            : resources.borrow(options.authHealth.resource);
      const members: PoolMember[] = [];
      for (const sourcePath of accounts.paths) {
        try {
          const credential = await provider.loadCredential(sourcePath);
          const id = subscriptionCredentialLabel(sourcePath);
          const credentialFingerprint = subscriptionCredentialFingerprint(sourcePath);
          authHealth.register(
            subscriptionAccountIdentity(provider.mode, id),
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
      const accountSet = new SubscriptionAccountSet(
        provider,
        {
          ...options,
          activity: { resource: activity, ownership: "borrowed" },
          authHealth: { resource: authHealth, ownership: "borrowed" }
        },
        members,
        tracker
      );
      resources.transferTo(accountSet.#resources);
      accountSet.#startProbe();
      return accountSet;
    } catch (error) {
      try {
        await resources.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "subscription account set startup failed");
      }
      throw error;
    }
  }

  get mode(): SubscriptionMode {
    return this.#provider.mode;
  }

  get size(): number {
    return this.#members.length;
  }

  snapshot(): SubscriptionAccountSetSnapshot {
    return this.#status.snapshot();
  }

  statusSnapshot(): SubscriptionAccountSetSnapshot {
    return this.#status.statusSnapshot();
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly string[]> {
    return await this.#catalog.discoverModels(signal);
  }

  listModelIds(): readonly string[] {
    return this.#catalog.listModelIds();
  }
  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.#catalog.reasoningCapabilities(model);
  }
  modelMetadata(model: string): ModelCapabilityMetadata | undefined {
    return this.#catalog.modelMetadata(model);
  }
  modelSelectionSignals(model: string): ModelSelectionSignals | undefined {
    return this.#catalog.modelSelectionSignals(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#probeTimer !== undefined) {
      clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
    if (this.#usageProbe !== undefined) await Promise.allSettled([this.#usageProbe]);
    await this.#resources.dispose();
  }

  async probe(signal?: AbortSignal): Promise<void> {
    await Promise.allSettled(
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
  }

  /** List banked rate-limit reset credits for one enrolled member. */
  async listResetCredits(label: string, signal?: AbortSignal): Promise<ResetCreditSnapshot> {
    const member = this.#requireMember(label);
    await this.#ensureFresh(member, signal);
    return await this.#resetCredits.list(member, signal);
  }

  /** Redeem one banked rate-limit reset for an enrolled member. */
  async redeemResetCredit(
    input: RedeemResetCreditInput,
    signal?: AbortSignal
  ): Promise<RedeemResetCreditResult> {
    const member = this.#requireMember(input.label);
    await this.#ensureFresh(member, signal);
    return await this.#resetCredits.redeem(
      input,
      member,
      (m, s) => this.#fetchUsageWithAuthRecovery(m, s),
      signal
    );
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
    return await this.#executor.execute(model, operation, signal, observer);
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
    return await this.#resetCredits.list(member, signal);
  }

  async #attachResetCredits(
    member: PoolMember,
    limits: AccountLimits,
    signal?: AbortSignal
  ): Promise<AccountLimits> {
    return await this.#resetCredits.attach(member, limits, signal);
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
          this.#selector.eligible(candidate, model, this.#catalogReady, now)
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
      return this.#selector.windowRelevant(key, limitName, context.model);
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
  ): Promise<readonly DiscoveredProviderModel[]> {
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
    throw this.#selector.unavailableError(undefined, this.#catalogReady);
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
